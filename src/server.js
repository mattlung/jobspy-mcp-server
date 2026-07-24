import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import SseManager from './sseManager.js';
import {
  jobRecommendationsPrompt,
  resumeFeedbackPrompt,
  searchJobsPrompt,
} from './prompts/index.js';
import { searchJobsTool } from './tools/index.js';

export function createMcpServer() {
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

  return { server, sseManager };
}
