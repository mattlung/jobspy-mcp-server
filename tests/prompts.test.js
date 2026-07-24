import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  jobRecommendationsPrompt,
  resumeFeedbackPrompt,
  searchJobsPrompt,
} from '../src/prompts/index.js';

test('registers and renders every prompt through the MCP protocol', async () => {
  const server = new McpServer({
    name: 'prompt-test-server',
    version: '1.0.0',
  });

  searchJobsPrompt(server);
  jobRecommendationsPrompt(server);
  resumeFeedbackPrompt(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'prompt-test-client',
    version: '1.0.0',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map(({ name }) => name).sort(),
      ['job_recommendations', 'resume_feedback', 'search_jobs'],
    );

    const cases = [
      {
        name: 'search_jobs',
        arguments: { query: 'remote JavaScript roles' },
        expectedText: 'remote JavaScript roles',
      },
      {
        name: 'job_recommendations',
        arguments: {
          skills: 'JavaScript, Node.js',
          experienceLevel: 'senior',
          preferredLocation: 'Remote',
          jobSeekerInterests: 'developer tools',
          jobType: 'full-time',
        },
        expectedText: 'JavaScript, Node.js',
      },
      {
        name: 'resume_feedback',
        arguments: {
          resumeText: 'Built and operated distributed systems.',
          targetRole: 'Staff Engineer',
          targetIndustry: 'Technology',
          experienceLevel: 'senior',
        },
        expectedText: 'Built and operated distributed systems.',
      },
    ];

    for (const prompt of cases) {
      const result = await client.getPrompt({
        name: prompt.name,
        arguments: prompt.arguments,
      });

      assert.ok(result.messages.length > 0);
      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.messages[0].content.type, 'text');
      assert.match(result.messages[0].content.text, new RegExp(prompt.expectedText));
    }
  } finally {
    await client.close();
  }
});
