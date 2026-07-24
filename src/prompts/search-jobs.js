import { z } from 'zod';

/**
 * Complete search jobs prompt definition for MCP server
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server - The MCP server instance
 * @returns {Object} The configured prompt
 */
export const searchJobsPrompt = server => server.registerPrompt(
  'search_jobs',
  {
    description: 'Extract job search parameters from a natural language query',
    argsSchema: {
      query: z.string().describe('Job search query'),
    },
  },
  (inputs) => {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `
You help users search for jobs by understanding their requirements.
Based on the user query, extract the parameters needed to find relevant jobs.

Extract search parameters from the following job search query: "${inputs.query}"

Provide the following information:
1. Job title or keywords
2. Location (if specified, otherwise assume "Remote")
3. Any specific companies mentioned
4. Job type preferences (full-time, part-time, contract, etc.)
5. Experience level requirements (entry, mid, senior)
            `,
          },
        },
      ],
    };
  },
);
