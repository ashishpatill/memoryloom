/**
 * Store snapshot and run record helpers for commands run outside
 * npm run verify (card S1a, the external command rule in Section 3
 * of the frozen master plan).
 *
 * The snapshot keeps only the sha256 hash of the real store bytes.
 * The store bytes themselves are never stored as evidence. The run
 * record is what an eligible live rehearsal or demo runner writes
 * at startup under the named exception, naming the command and the
 * entry point, the start time, the settings file value by path
 * only and the store snapshot hash.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'checks', 'out');

/**
 * The real store is the default store file in the repo root. It is
 * computed directly here and never through the settings file
 * override, because a suite may set that override to its own
 * temporary store during its run, and the snapshot must keep
 * pointing at the real file the whole time.
 */
export function realStorePath() {
  return path.join(REPO_ROOT, '.env.local');
}

export function snapshotRealStore() {
  const p = realStorePath();
  let hash = null;
  try {
    if (existsSync(p)) hash = createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    hash = null;
  }
  return { path: p, hash };
}

export function realStoreChangedSince(snapshot) {
  if (!snapshot) return true;
  const current = snapshotRealStore();
  if (snapshot.hash === null && current.hash === null) return false;
  return current.hash !== snapshot.hash;
}

export function writeRunRecord({ command, entryPoint, snapshotHash = null } = {}) {
  const startedAt = new Date().toISOString();
  const base = entryPoint ? path.basename(entryPoint, path.extname(entryPoint)) : 'unknown';
  mkdirSync(OUT_DIR, { recursive: true });
  const recordPath = path.join(OUT_DIR, `run-record-${base}-${startedAt.replace(/:/g, '-')}.json`);
  const record = {
    command: command || null,
    entry_point: entryPoint || null,
    started_at: startedAt,
    settings_file: process.env.MEMORYLOOM_SETTINGS_FILE || null,
    store_snapshot_sha256: snapshotHash,
    note: 'this run uses the real store by design under the named exception for deliberate live rehearsal and demo runs',
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return recordPath;
}
