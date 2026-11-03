/**
 * Roundtrip check: store a fact through the MCP server over stdio,
 * then recall it by its unique marker.
 *
 * Since card S3a the store tool routes through the write gate. In
 * the keyless mode this check runs in, the gate fails closed and
 * the store call queues, so the roundtrip completes the human
 * step the contract prescribes. It promotes the queued proposal
 * through the promote tool, and only then recalls. When a gate
 * backend is configured and approves the call, the promotion step
 * is skipped and the stored id is recalled directly.
 *
 * Writes only to the 'memoryloom-test' namespace of DATABASE_URL.
 * Usage: DATABASE_URL=postgres://... node checks/roundtrip.mjs
 * Owning file: checks/roundtrip.mjs
 * Accountable layer: MCP layer
 * Provider need: None
 * Declared mode: Keyless, separate dated command in the runbook
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { preflightOrExit } from './db-preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
preflightOrExit({ storeFallback: true });

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
    request_id: `roundtrip-store-${Date.now()}`,
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

// The gate contract (card S3a). A queued store call becomes a
// record only through a human decision, so the roundtrip takes
// that step through the promote tool. An approved call already
// holds its record id.
let memoryId = storeJson.id || null;
let promoteJson = null;
if (!memoryId && storeJson.decision === 'queued_for_review' && storeJson.proposal_id) {
  const promoteRes = await client.callTool({
    name: 'promote',
    arguments: { proposal_id: storeJson.proposal_id, decided_by: 'ml-roundtrip' },
  });
  promoteJson = JSON.parse(promoteRes.content?.[0]?.text || '');
  memoryId = promoteJson.promoted_id || null;
}

const recallRes = await client.callTool({
  name: 'recall',
  arguments: { namespace, query: marker, k: 5 },
});
const recallJson = JSON.parse(recallRes.content?.[0]?.text || '');

const hit = (recallJson.results || []).some(
  (r) => r.id === memoryId || (r.text && r.text.includes(marker))
);

const out = {
  ok: hit && storeJson.status === 'ok' && Boolean(memoryId),
  tools: tools.tools.map((t) => t.name),
  store: storeJson,
  promote: promoteJson,
  memory_id: memoryId,
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
console.log(JSON.stringify({ written: outPath, ok: out.ok, hit, store_id: memoryId, store_decision: storeJson.decision, recall_status: recallJson.status, elapsed_ms: out.elapsed_ms }, null, 2));

await client.close();
process.exit(out.ok ? 0 : 1);
