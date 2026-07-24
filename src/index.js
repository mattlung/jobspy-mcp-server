import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import cors from 'cors';
import logger from './logger.js';
import SseManager from './sseManager.js';
import {
  searchJobsPrompt,
  jobRecommendationsPrompt,
  resumeFeedbackPrompt,
} from './prompts/index.js';
import { searchJobsTool, searchJobsHandler } from './tools/index.js';

// Environment configuration
const PORT = Number(process.env.JOBSPY_PORT || process.env.PORT || 9423);
const HOST = process.env.JOBSPY_HOST || process.env.HOST || '0.0.0.0';
const ENABLE_SSE = ['1', 'true', 'yes', 'on'].includes(
  (process.env.ENABLE_SSE || '').toLowerCase(),
);

// Create the MCP server
const server = new McpServer({
  name: 'JobSpy MCP Server',
  version: '1.0.0',
  description:
    'A Model Context Protocol server that enables searching for jobs across various platforms',
});

const sseManager = new SseManager(server);

searchJobsPrompt(server);
jobRecommendationsPrompt(server);
resumeFeedbackPrompt(server);
searchJobsTool(server, sseManager);

// Initialize transports
let stdioTransport = null;
let httpServer = null;
let shutdownStarted = false;

// Start the server with configured transports
async function runServer() {
  logger.info('Starting JobSpy MCP server...');

  try {
    // Initialize and connect transports
    const connectedTransports = [];

    // Set up SSE transport if enabled
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
          logger.info(`SSE server listening at http://${HOST}:${PORT}`);
        });

        connectedTransports.push('SSE');

        logger.info(`SSE transport listening at http://${HOST}:${PORT}/sse`);
        logger.info(
          `Send endpoint available at http://${HOST}:${PORT}/messages`,
        );
      } catch (error) {
        logger.error('Failed to connect SSE transport', {
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
