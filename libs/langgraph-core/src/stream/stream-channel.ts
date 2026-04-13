/**
 * StreamChannel — named projection that auto-forwards to the protocol stream.
 *
 * A `StreamChannel<T>` wraps an {@link EventLog} and declares a protocol
 * channel name.  When registered with a {@link StreamMux} (via a
 * transformer's `init()` return value), every {@link push} is automatically
 * forwarded as a {@link ProtocolEvent} on the named channel — making the
 * data available both in-process (via `run.extensions`) and to remote
 * clients (via `session.subscribe("custom:<channelName>")`).
 *
 * Lifecycle (`close` / `fail`) is managed by the mux automatically;
 * transformers do not need to call them.
 */

import { EventLog } from "./event-log.js";

/**
 * A named, auto-forwarding projection channel for {@link StreamTransformer}s.
 *
 * Implements `AsyncIterable<T>` so it can be iterated directly by
 * in-process consumers via `run.extensions.<key>`.
 *
 * @typeParam T - The type of items pushed into the channel.
 */
export class StreamChannel<T> implements AsyncIterable<T> {
  /** Protocol channel name used for auto-forwarded events. */
  readonly channelName: string;

  readonly #log = new EventLog<T>();
  #onPush?: (item: T) => void;

  constructor(name: string) {
    this.channelName = name;
  }

  /**
   * Append an item to the channel.  If wired to a mux, the item is also
   * injected into the main protocol event stream under {@link channelName}.
   */
  push(item: T): void {
    this.#log.push(item);
    this.#onPush?.(item);
  }

  /** @internal Called by the mux to wire auto-forwarding. */
  _wire(fn: (item: T) => void): void {
    this.#onPush = fn;
  }

  /** @internal Called by the mux on normal completion. */
  _close(): void {
    this.#log.close();
  }

  /** @internal Called by the mux on failure. */
  _fail(err: unknown): void {
    this.#log.fail(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.#log.iterate();
  }
}

/**
 * Type guard that tests whether a value is a {@link StreamChannel}.
 */
export function isStreamChannel(
  value: unknown
): value is StreamChannel<unknown> {
  return value instanceof StreamChannel;
}
