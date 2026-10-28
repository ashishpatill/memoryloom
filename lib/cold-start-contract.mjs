/**
 * P1.M9 — cold-start contract for recall envelopes (plan §8, §13.5).
 *
 * Agents must surface cold_start|thin|ok and never invent memories.
 * Contract fields report whether the vector index / daemon path is warm
 * and replica lag when serving from a device replica (null on Neon primary).
 */

/**
 * @param {object} opts
 * @param {'neon'|'stub'|'replica'} [opts.source]
 * @param {number} [opts.indexedCount] live indexed+embedded rows in namespace
 * @param {number} [opts.pendingEmbeddings] live rows with embedding IS NULL in namespace
 * @param {number|null} [opts.lastSeq] max(sync_log.seq) or replica watermark
 * @param {number|null} [opts.replicaLag] source_last_seq - local_last_seq; null on primary
 * @param {'warm'|'cold'|'unknown'|null} [opts.daemon] explicit override (or MEMORY_DAEMON_STATUS)
 */
export function buildRecallContract(opts = {}) {
  const source = opts.source || 'neon';
  const indexedCount = Number(opts.indexedCount || 0);
  const pendingEmbeddings = Number(opts.pendingEmbeddings || 0);
  const lastSeq = opts.lastSeq == null || opts.lastSeq === '' ? null : Number(opts.lastSeq);
  const replicaLag =
    opts.replicaLag == null || opts.replicaLag === '' ? null : Number(opts.replicaLag);

  const index = indexedCount > 0 ? 'warm' : 'cold';

  const envDaemon = process.env.MEMORY_DAEMON_STATUS;
  let daemon = opts.daemon || envDaemon || null;
  if (!daemon) {
    if (source === 'stub') {
      daemon = 'unknown';
    } else if (pendingEmbeddings > 0) {
      // Staged backlog implies daemon has not drained embed jobs yet.
      daemon = 'cold';
    } else if (lastSeq != null && lastSeq > 0) {
      daemon = 'warm';
    } else {
      daemon = 'unknown';
    }
  }
  if (!['warm', 'cold', 'unknown'].includes(daemon)) {
    daemon = 'unknown';
  }

  return {
    version: 1,
    source,
    index,
    daemon,
    last_seq: lastSeq,
    replica_lag: replicaLag,
    pending_embeddings: pendingEmbeddings,
  };
}

/** Validate minimal shape used by conformance/smoke. */
export function assertContractShape(contract) {
  if (!contract || typeof contract !== 'object') return 'missing contract';
  if (contract.version !== 1) return 'contract.version != 1';
  if (!['neon', 'stub', 'replica'].includes(contract.source)) return 'bad source';
  if (!['warm', 'cold'].includes(contract.index)) return 'bad index';
  if (!['warm', 'cold', 'unknown'].includes(contract.daemon)) return 'bad daemon';
  if (!(contract.last_seq === null || Number.isFinite(contract.last_seq))) return 'bad last_seq';
  if (!(contract.replica_lag === null || Number.isFinite(contract.replica_lag))) {
    return 'bad replica_lag';
  }
  return null;
}
