/**
 * Shared reconnect defaults and backoff for SSE (`streamWithRetry`) and
 * protocol transports (WebSocket / SSE adapters). Keep these in one place so
 * legacy and v2 clients do not diverge.
 */

/** Default max reconnect / retry attempts after an unexpected disconnect. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/** Base delay (ms) for exponential reconnect backoff (`base * 2^(attempt-1)`). */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;

/** Cap (ms) for exponential reconnect backoff before jitter. */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 5000;

/** Max random jitter (ms) added on top of the capped base delay. */
export const DEFAULT_RECONNECT_JITTER_MS = 1000;

/**
 * Exponential backoff with jitter for stream reconnect.
 * `min(base * 2^(attempt-1), max) + random(0, jitter)`.
 */
export function reconnectDelayMs(attempt: number): number {
  const baseDelay = Math.min(
    DEFAULT_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    DEFAULT_RECONNECT_MAX_DELAY_MS
  );
  const jitter = Math.random() * DEFAULT_RECONNECT_JITTER_MS;
  return baseDelay + jitter;
}
