import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getAvailablePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => {
    socket.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the HTTP server');
}

test('serves MCP over Streamable HTTP at /mcp', async () => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENABLE_SSE: '1',
      JOBSPY_HOST: '127.0.0.1',
      JOBSPY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });

  const client = new Client({
    name: 'http-test-client',
    version: '1.0.0',
  });
  let connected = false;

  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`, child);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    connected = true;

    const { prompts } = await client.listPrompts();
    const { tools } = await client.listTools();
    assert.deepEqual(
      prompts.map(({ name }) => name).sort(),
      ['job_recommendations', 'resume_feedback', 'search_jobs'],
    );
    assert.deepEqual(tools.map(({ name }) => name), ['search_jobs']);
  } finally {
    if (connected) {
      await client.close();
    }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
    const [exitCode] = child.exitCode === null
      ? await once(child, 'exit')
      : [child.exitCode];
    assert.equal(exitCode, 0, output);
  }
});
