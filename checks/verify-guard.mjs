/**
 * Verify entry guard check (card S2, Section 10.2 of the frozen
 * master plan). The named inherited value test for the verify
 * entry protections.
 *
 * Owning file: checks/verify-guard.mjs
 * Accountable layer: all layers, it guards the green baseline gate
 * Provider need: none
 * Declared mode: keyless, separate dated command in the runbook.
 *   This check is not part of the verify entry, because it runs
 *   the verify entry as its subject.
 *
 * Test one runs the verify entry with MEMORYLOOM_SETTINGS_FILE
 * inherited from the caller and pointing at the real repo store
 * file. The entry must reject the run at startup, before any suite
 * starts, and the file it points at must be unchanged.
 *
 * Test two runs the verify entry with a decoy settings file
 * inherited. The run must proceed, every suite line in the output
 * must name a temporary settings file inside the verify temp
 * folder as the store it was given, no suite line may name the
 * decoy, and the decoy file must be unchanged after the run.
 * Test two runs a full verify, so this check takes minutes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const realStore = join(root, '.env.local');
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let passes = 0;
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) { passes++; console.log(`  PASS ${label}`); }
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

console.log('test one: inherited value naming the real store is rejected at startup');
{
  const before = hashOf(realStore);
  const t0 = Date.now();
  const r = spawnSync('node', ['checks/verify-all.mjs'], {
    cwd: root,
    env: { ...process.env, MEMORYLOOM_SETTINGS_FILE: realStore },
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert(r.status === 1, 'verify entry exits 1 on the inherited real store path', `exit ${r.status}`);
  assert(out.includes('startup rejection'), 'the refusal is the startup rejection');
  assert(!out.includes('Step 4'), 'no suite started');
  assert(Date.now() - t0 < 60000, 'the rejection happens at startup, not after a run');
  assert(hashOf(realStore) === before, 'the file the variable points at is unchanged');
}

console.log('test two: a decoy inherited value is never used as the settings store');
{
  const dir = mkdtempSync(join(tmpdir(), 'ml-verify-guard-'));
  const decoy = join(dir, 'decoy.env.local');
  writeFileSync(decoy, 'TYPESAFE_API_KEY=decoy-dummy-key-never-used\n', { mode: 0o600 });
  const before = hashOf(decoy);
  const r = spawnSync('node', ['checks/verify-all.mjs'], {
    cwd: root,
    env: { ...process.env, MEMORYLOOM_SETTINGS_FILE: decoy },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const suiteLines = out.split('\n').filter((l) => /^(backend|frontend|AI layer) \/ .*store=/.test(l));
  assert(r.status === 0, 'verify entry passes with a decoy inherited value', `exit ${r.status}`);
  assert(suiteLines.length >= 10, 'every suite line names the store it was given', `${suiteLines.length} suite lines`);
  assert(suiteLines.every((l) => l.includes('ml-verify-settings-')), 'every suite ran with a temporary settings file from the verify temp folder');
  assert(!suiteLines.some((l) => l.includes(decoy)), 'no suite was given the decoy as its settings store');
  assert(hashOf(decoy) === before, 'the decoy file is unchanged after the run');
}

console.log(`verify-guard: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
