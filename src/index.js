import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import logger from './logger.js';
import { createMcpServer } from './server.js';
import { searchJobsHandler } from './tools/index.js';

// Environment configuration
const PORT = Number(process.env.JOBSPY_PORT || process.env.PORT || 9423);
const HOST = process.env.JOBSPY_HOST || process.env.HOST || '0.0.0.0';
const ENABLE_SSE = ['1', 'true', 'yes', 'on'].includes(
  (process.env.ENABLE_SSE || '').toLowerCase(),
);

const { server, sseManager } = createMcpServer();

// Initialize transports
let stdioTransport = null;
let httpServer = null;
let shutdownStarted = false;
const streamableSessions = new Map();

// Start the server with configured transports
async function runServer() {
  logger.info('Starting JobSpy MCP server...');

  try {
    // Initialize and connect transports
    const connectedTransports = [];

    // Set up HTTP transports if enabled
    if (ENABLE_SSE) {
      try {
        // Create Express app
        const app = express();

        // Configure CORS
        app.use(cors());

        // Configure Express middleware
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // Health check endpoint
        app.get('/health', (req, res) => {
          res.status(200).json({ status: 'ok' });
        });

        // Streamable HTTP endpoint used by Manufact and current MCP clients
        app.all('/mcp', async (req, res) => {
          const sessionIdHeader = req.headers['mcp-session-id'];
          const sessionId = typeof sessionIdHeader === 'string'
            ? sessionIdHeader
            : undefined;
          let session = sessionId
            ? streamableSessions.get(sessionId)
            : undefined;

          try {
            if (sessionId && !session) {
              res.status(404).json({
                jsonrpc: '2.0',
                error: {
                  code: -32001,
                  message: 'Unknown MCP session',
                },
                id: null,
              });
              return;
            }

            if (!session) {
              if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
                res.status(400).json({
                  jsonrpc: '2.0',
                  error: {
                    code: -32000,
                    message: 'An MCP initialization request is required',
                  },
                  id: null,
                });
                return;
              }

              const configuredServer = createMcpServer();
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (initializedSessionId) => {
                  streamableSessions.set(initializedSessionId, session);
                  logger.info(
                    `Streamable HTTP session initialized: ${initializedSessionId}`,
                  );
                },
              });
              session = {
                server: configuredServer.server,
                transport,
              };
              transport.onclose = () => {
                const closedSessionId = transport.sessionId;
                if (closedSessionId) {
                  streamableSessions.delete(closedSessionId);
                  logger.info(
                    `Streamable HTTP session closed: ${closedSessionId}`,
                  );
                }
              };

              await session.server.connect(transport);
            }

            await session.transport.handleRequest(req, res, req.body);
          } catch (error) {
            logger.error('Failed to handle Streamable HTTP request', {
              error: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: 'Internal server error',
                },
                id: null,
              });
            }
          }
        });

        // SSE endpoint for client connections
        app.get('/sse', async (req, res) => {
          const transport = sseManager.createTransport('/messages', res);

          res.on('close', () => {
            sseManager.removeTransport(transport.sessionId);
            logger.info(`Client disconnected: ${transport.sessionId}`);
          });

          await server.connect(transport);
          logger.info(`New SSE client connected: ${transport.sessionId}`);
        });

        // Message handling endpoint
        app.post('/messages', async (req, res) => {
          const transport = sseManager.getTransport(req);

          if (transport) {
            await transport.handlePostMessage(req, res, req.body);
          } else {
            res.status(400).send('No transport found for sessionId');
          }
        });

        app.post('/api', async (req, res) => {
          const data = searchJobsHandler(req.body);
          res.json(data);
        });

        // Start the Express server
        httpServer = app.listen(PORT, HOST, () => {
          logger.info(`MCP HTTP server listening at http://${HOST}:${PORT}`);
        });

        connectedTransports.push('HTTP');

        logger.info(`MCP endpoint available at http://${HOST}:${PORT}/mcp`);
        logger.info(`SSE transport listening at http://${HOST}:${PORT}/sse`);
        logger.info(
          `Send endpoint available at http://${HOST}:${PORT}/messages`,
        );
      } catch (error) {
        logger.error('Failed to start HTTP transport', {
          error: error.message,
          stack: error.stack,
        });
      }
    } else {
      // Set up stdio transport if no SSE
      try {
        stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);
        connectedTransports.push('stdio');

        logger.info('Stdio transport connected');
      } catch (error) {
        logger.error('Failed to connect stdio transport', {
          error: error.message,
        });
      }
    }

    // Ensure at least one transport is connected
    if (connectedTransports.length === 0) {
      throw new Error('No transports connected. Check configuration.');
    }

    logger.info(
      `Server successfully connected with transports: ${connectedTransports.join(
        ', ',
      )}`,
    );
  } catch (error) {
    logger.error('Server connection error', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown() {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  logger.info('Shutting down JobSpy MCP server...');

  try {
    await Promise.all(
      Array.from(
        streamableSessions.values(),
        ({ transport }) => transport.close(),
      ),
    );
    streamableSessions.clear();
    await server.close();

    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    logger.info('Server shutdown complete');
    process.exitCode = 0;
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exitCode = 1;
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run the server
runServer().catch((error) => {
  logger.error('Unhandled error in server', { error: error.message });
  process.exit(1);
});
