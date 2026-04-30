/**
 * StreamChannel — projection channel for local or remote streaming.
 *
 * A `StreamChannel<T>` is an append-only async stream with independent
 * cursors. Local channels stay in-process only. Remote channels declare a
 * protocol channel name; when registered with a {@link StreamMux} (via a
 * transformer's `init()` return value), every {@link push} is automatically
 * forwarded as a {@link ProtocolEvent} on the named channel — making the data
 * available both in-process (via `run.extensions`) and to remote clients (via
 * `session.subscribe("custom:<channelName>")`).
 *
 * Lifecycle (`close` / `fail`) is managed by the mux automatically;
 * transformers do not need to call them.
 */

/**
 * Branded symbol placed on every {@link StreamChannel} instance.
 *
 * Uses `Symbol.for` so the same symbol is shared across multiple
 * copies of this package that may coexist in a dependency graph
 * (e.g. when a user app imports `@langchain/langgraph` directly and a
 * wrapping library like `langchain` bundles its own copy). Using a
 * symbol brand instead of `instanceof` lets channels created against
 * one copy of the class be recognised by a mux from another.
 * @internal
 */
export const STREAM_CHANNEL_BRAND: unique symbol = Symbol.for(
  "langgraph.stream_channel"
) as typeof STREAM_CHANNEL_BRAND;

export interface StreamChannelEventStreamOptions<T> {
  /**
   * SSE event name. Defaults to the channel's remote protocol name, if any.
   * Set this for local channels or when exposing the same channel under a
   * route-specific event name.
   */
  event?: string;
  /**
   * Cursor position to start streaming from. Useful for reconnects or
   * secondary subscribers that already consumed the first N buffered items and
   * only need replay from a known offset.
   */
  startAt?: number;
  /**
   * Serialize each item into the SSE `data:` field. Defaults to JSON. Use this
   * when a channel item needs a wire format other than its raw JSON shape, or
   * when the consumer expects line-oriented text payloads.
   */
  serialize?: (item: T) => string;
}

/**
 * A projection channel for {@link StreamTransformer}s.
 *
 * Implements `AsyncIterable<T>` so it can be iterated directly by
 * in-process consumers via `run.extensions.<key>`. Channels created with
 * {@link StreamChannel.remote} or `new StreamChannel(name)` are also
 * auto-forwarded to remote clients.
 *
 * @typeParam T - The type of items pushed into the channel.
 */
export class StreamChannel<T> implements AsyncIterable<T> {
  /** @internal Brand used by {@link StreamChannel.isInstance}. */
  readonly [STREAM_CHANNEL_BRAND] = true as const;

  /** Protocol channel name used for auto-forwarded events, if remote. */
  readonly channelName?: string;

  #items: T[] = [];
  #waiters: Array<() => void> = [];
  #done = false;
  #error: unknown;
  #onPush?: (item: T) => void;

  constructor(name?: string) {
    this.channelName = name;
  }

  /**
   * Create an in-process-only channel.  Values remain available through
   * `run.extensions.<key>` but are not forwarded to remote clients.
   */
  static local<T>(): StreamChannel<T> {
    return new StreamChannel<T>();
  }

  /**
   * Create a channel whose pushes are forwarded to remote clients under
   * the given protocol channel name.
   */
  static remote<T>(name: string): StreamChannel<T> {
    return new StreamChannel<T>(name);
  }

  /**
   * Brand-based type guard that recognises any {@link StreamChannel}
   * instance, even ones originating from a different copy of this
   * package. Prefer this over `instanceof StreamChannel` when code
   * may observe channels that were constructed elsewhere.
   */
  static isInstance(value: unknown): value is StreamChannel<unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      STREAM_CHANNEL_BRAND in value &&
      (value as { [STREAM_CHANNEL_BRAND]: unknown })[STREAM_CHANNEL_BRAND] ===
        true
    );
  }

  /**
   * Append an item to the channel.  If this is a remote channel wired to a
   * mux, the item is also injected into the main protocol event stream under
   * {@link channelName}.
   */
  push(item: T): void {
    this.#items.push(item);
    this.#wake();
    this.#onPush?.(item);
  }

  /**
   * Returns an async iterator starting at position {@link startAt}. Each call
   * returns an independent cursor so multiple consumers can iterate the same
   * channel concurrently.
   */
  iterate(startAt = 0): AsyncIterator<T> {
    let cursor = startAt;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (cursor < this.#items.length) {
            return { value: this.#items[cursor++], done: false };
          }
          if (this.#done) {
            if (this.#error) throw this.#error;
            return { value: undefined as unknown as T, done: true };
          }
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
      },
    };
  }

  /**
   * Creates an {@link AsyncIterable} backed by this channel, starting from
   * {@link startAt}.
   */
  toAsyncIterable(startAt = 0): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => this.iterate(startAt),
    };
  }

  /**
   * Creates a web {@link ReadableStream} that emits channel items as
   * Server-Sent Events. Useful for returning a channel directly from
   * `new Response(channel.toEventStream())`.
   */
  toEventStream(
    options: StreamChannelEventStreamOptions<T> = {}
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = this.iterate(options.startAt);
    const event = options.event ?? this.channelName;
    const serialize =
      options.serialize ?? ((item: T) => JSON.stringify(item) ?? "null");

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }

          const lines: string[] = [];
          if (event != null) {
            lines.push(`event: ${event}`);
          }
          for (const line of serialize(next.value).split(/\r\n|\r|\n/)) {
            lines.push(`data: ${line}`);
          }

          controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }

  /**
   * Returns the item at the given zero-based index.
   *
   * @throws {RangeError} If the index is out of bounds.
   */
  get(index: number): T {
    if (index < 0 || index >= this.#items.length) {
      throw new RangeError(
        `StreamChannel index ${index} out of bounds (size=${this.#items.length})`
      );
    }
    return this.#items[index];
  }

  /** The number of items currently buffered in the channel. */
  get size(): number {
    return this.#items.length;
  }

  /** Whether the channel has been closed or failed. */
  get done(): boolean {
    return this.#done;
  }

  /** Mark the channel as complete after all buffered items are consumed. */
  close(): void {
    this.#done = true;
    this.#wake();
  }

  /** Mark the channel as failed after all buffered items are consumed. */
  fail(err: unknown): void {
    this.#error = err;
    this.#done = true;
    this.#wake();
  }

  /** @internal Called by the mux to wire auto-forwarding. */
  _wire(fn: (item: T) => void): void {
    this.#onPush = fn;
  }

  /** @internal Called by the mux on normal completion. */
  _close(): void {
    this.close();
  }

  /** @internal Called by the mux on failure. */
  _fail(err: unknown): void {
    this.fail(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iterate();
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const w of waiters) w();
  }
}

/**
 * Type guard that tests whether a value is a {@link StreamChannel}.
 *
 * Uses a symbol brand rather than `instanceof` so channels built
 * against a different copy of this package (e.g. one bundled by the
 * `langchain` umbrella package) are still recognised.
 */
export function isStreamChannel(
  value: unknown
): value is StreamChannel<unknown> {
  return StreamChannel.isInstance(value);
}
