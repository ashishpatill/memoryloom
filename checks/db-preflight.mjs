/**
 * Shared preflight for check entry points (card S1a, Section 10.4
 * and the external command rule in Section 3 of the frozen master
 * plan). A suite, harness or script that reads the database setting
 * directly calls this first, before it creates any pool or spawns
 * any child, so a forbidden target stops the run before any write.
 *
 * The store half of the preflight serves commands run outside
 * npm run verify. It records the settings file value by path only,
 * refuses to start when that path resolves to the real repo store
 * file, and snapshots the real store bytes by hash so the caller
 * can compare after the run. Only the hash is ever kept. The store
 * bytes themselves are never stored as evidence.
 * Owning file: checks/db-preflight.mjs
 * Accountable layer: backend and security support for every check entry point
 * Provider need: none
 * Declared mode: support module, runs inside the suites that import it
 */
import path from 'node:path';
import { evaluateDbGate } from '../lib/db-gate.mjs';
import { readLocalEnv } from '../lib/load-env.mjs';
import { realStoreChangedSince, realStorePath, snapshotRealStore, writeRunRecord } from '../lib/run-record.mjs';

export { realStoreChangedSince, snapshotRealStore, writeRunRecord };

/**
 * Resolve the database URL the way the calling entry point will see
 * it and run the gate. With storeFallback the store DATABASE_URL is
 * used when the environment carries none, which is how the MCP entry
 * resolves it through dotenv. Exits with code 1 on a refusal, before
 * the caller has connected or spawned anything.
 */
export function preflightDbOrExit({ operation = null, storeFallback = false } = {}) {
  const url = process.env.DATABASE_URL || (storeFallback ? readLocalEnv('DATABASE_URL') : null);
  if (!url) {
    console.error('DATABASE_URL missing, the pre run database gate cannot pass');
    process.exit(1);
  }
  const result = evaluateDbGate({ url, operation });
  if (!result.allowed) {
    console.error(`db gate refusal: ${result.reason}`);
    process.exit(1);
  }
  return result;
}

/**
 * The external command rule for the settings file. When the value
 * resolves to the real repo store file the command fails before
 * running. Returns the recorded value by path only, or null when
 * the variable is unset. Eligible live rehearsal and demo runners
 * do not call this. They write a run record instead.
 */
export function guardSettingsFileOrExit() {
  const recorded = process.env.MEMORYLOOM_SETTINGS_FILE;
  if (!recorded) return null;
  if (path.resolve(recorded) === realStorePath()) {
    console.error('settings guard refusal: MEMORYLOOM_SETTINGS_FILE resolves to the real repo store file, so this external command cannot run');
    process.exit(1);
  }
  return recorded;
}

/**
 * The store half alone, for entry points whose database use is
 * optional or starts later. Registers the closing store comparison
 * on process exit and returns the snapshot.
 */
export function preflightStoreOnly() {
  guardSettingsFileOrExit();
  const snapshot = snapshotRealStore();
  process.on('exit', () => {
    if (realStoreChangedSince(snapshot)) {
      console.error('store guard: the real settings store changed during this run');
      process.exitCode = process.exitCode || 1;
    }
  });
  return snapshot;
}

/**
 * Run both preflight halves for a check entry point and register
 * the closing store comparison on process exit. Returns the gate
 * result and the store snapshot.
 */
export function preflightOrExit(opts = {}) {
  guardSettingsFileOrExit();
  const snapshot = snapshotRealStore();
  process.on('exit', () => {
    if (realStoreChangedSince(snapshot)) {
      console.error('store guard: the real settings store changed during this run');
      process.exitCode = process.exitCode || 1;
    }
  });
  const gate = preflightDbOrExit(opts);
  return { gate, snapshot };
}
