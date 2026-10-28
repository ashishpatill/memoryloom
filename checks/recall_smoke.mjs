/**
 * recall_smoke.mjs — one-shot hybrid RRF recall smoke check.
 * Drives the MemoryLoom MCP server over stdio and calls `recall`.
 * Usage: DATABASE_URL=postgres://... node checks/recall_smoke.mjs "<namespace>" "<query>" [k]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(__dirname, '..', 'mcp', 'index.mjs');
const [namespace, query, k] = process.argv.slice(2);
if (!namespace || !query) {
  console.error('Usage: node checks/recall_smoke.mjs "<namespace>" "<query>" [k]');
  process.exit(2);
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [MCP],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'recall-smoke-cli', version: '1.0.0' });
await client.connect(transport);
const res = await client.callTool({
  name: 'recall',
  arguments: { namespace, query, k: k ? Number(k) : 5 },
});
console.log(res.content[0].text);
await client.close();
