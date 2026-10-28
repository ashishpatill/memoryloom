/**
 * Roundtrip check (adapted from the C0 proof): store a fact through the
 * MCP server over stdio, then recall it by its unique marker.
 * Writes only to the 'memoryloom-test' namespace of DATABASE_URL.
 * Usage: DATABASE_URL=postgres://... node checks/roundtrip.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const marker = `ML-SPIKE-FACT-${Date.now()}`;
const namespace = 'memoryloom-test';
const text = `A fictional field team prefers offline-first memory; spike marker ${marker}.`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, '..', 'mcp', 'index.mjs')],
  env: { ...process.env },
  stderr: 'pipe',
});

const client = new Client({ name: 'ml-roundtrip', version: '0.0.1' });
const t0 = Date.now();
await client.connect(transport);

const tools = await client.listTools();
const storeRes = await client.callTool({
  name: 'store',
  arguments: {
    namespace,
    text,
    metadata: {
      type: 'semantic',
      scope: 'global',
      author: 'ml-roundtrip',
      origin: 'roundtrip-check',
      source_session: 'ml-roundtrip',
      importance: 8,
    },
  },
});
const storeJson = JSON.parse(storeRes.content?.[0]?.text || '');

const recallRes = await client.callTool({
  name: 'recall',
  arguments: { namespace, query: marker, k: 5 },
});
const recallJson = JSON.parse(recallRes.content?.[0]?.text || '');

const hit = (recallJson.results || []).some(
  (r) => r.id === storeJson.id || (r.text && r.text.includes(marker))
);

const out = {
  ok: hit && storeJson.status === 'ok',
  tools: tools.tools.map((t) => t.name),
  store: storeJson,
  recall: {
    status: recallJson.status,
    count: recallJson.count,
    ids: (recallJson.results || []).map((r) => r.id),
    hit,
  },
  elapsed_ms: Date.now() - t0,
  at: new Date().toISOString(),
};

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'roundtrip.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ written: outPath, ok: out.ok, hit, store_id: storeJson.id, recall_status: recallJson.status, elapsed_ms: out.elapsed_ms }, null, 2));

await client.close();
process.exit(out.ok ? 0 : 1);
