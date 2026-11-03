/**
 * Stable error names for backend failures (frozen master plan,
 * Section 5, card S3b).
 *
 * Every failure that reaches an MCP caller or an HTTP caller
 * carries one stable error name from the fixed set below, plus a
 * plain detail sentence. Raw error text from a database, a
 * provider or a library never travels in the payload, because it
 * can carry a provider response body, a connection detail or a
 * stack fragment. The raw error stays in the server log, where
 * the caller of this module already put it.
 *
 * The mapping is the one place that decides the name. A failure
 * this module does not recognise is named INTERNAL, never passed
 * through under its own text.
 */

export const STABLE_ERROR_NAMES = new Set([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'REQUEST_ID_REUSED',
  'DATABASE_FAILURE',
  'DECISION_BACKEND_FAILURE',
  'PROVIDER_FAILURE',
  'INTERNAL',
]);

const PLAIN_DETAIL = {
  REQUEST_ID_REUSED: 'this request id was already used with a different payload',
  FORBIDDEN: 'this action is only available from the local app',
  DATABASE_FAILURE: 'the database did not complete the request',
  DECISION_BACKEND_FAILURE: 'the decision backend did not answer',
  PROVIDER_FAILURE: 'the provider did not answer',
  INTERNAL: 'the request did not complete',
};

// Names whose detail text is written by our own code at the raise
// site and is safe to carry. Every other name takes the fixed
// plain sentence above, whatever the raw error said.
const CALLER_DETAIL_NAMES = new Set(['VALIDATION', 'NOT_FOUND', 'CONFLICT']);

/** The stable error name for any thrown failure. */
export function stableErrorName(err) {
  if (!err || typeof err !== 'object') return 'INTERNAL';
  if (typeof err.error === 'string' && STABLE_ERROR_NAMES.has(err.error)) return err.error;
  if (
    err.name === 'JevError' || err.name === 'DecisionError' ||
    err.constructor?.name === 'JevError' || err.constructor?.name === 'DecisionError'
  ) return 'DECISION_BACKEND_FAILURE';
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return 'DATABASE_FAILURE';
  if (err instanceof SyntaxError || err.name === 'SyntaxError') return 'VALIDATION';
  if (
    err.name === 'AbortError' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    (err instanceof TypeError && /fetch/i.test(String(err.message || '')))
  ) {
    return 'PROVIDER_FAILURE';
  }
  return 'INTERNAL';
}

/**
 * The failure payload for an MCP tool result or an HTTP response.
 * `callerDetail` is used only for the names in CALLER_DETAIL_NAMES.
 * Returns { status: 'error', error, detail }.
 */
export function failurePayload(err, callerDetail = null) {
  const name = stableErrorName(err);
  const detail =
    CALLER_DETAIL_NAMES.has(name) && callerDetail
      ? String(callerDetail)
      : PLAIN_DETAIL[name] || PLAIN_DETAIL.INTERNAL;
  return { status: 'error', error: name, detail };
}
