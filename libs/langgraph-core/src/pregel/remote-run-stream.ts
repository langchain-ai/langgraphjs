import type { Channel, Event } from "@langchain/protocol";
import type { Client, ThreadStream } from "@langchain/langgraph-sdk";

import { GraphRunStream, SubgraphRunStream } from "../stream/run-stream.js";
import { StreamMux } from "../stream/mux.js";
import type {
  ChatModelStreamHandle,
  InterruptPayload,
  ProtocolEvent,
} from "../stream/types.js";
import type { LifecycleEntry } from "../stream/transformers/index.js";

const REMOTE_V3_CHANNELS: Channel[] = [
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "tasks",
  "checkpoints",
  "lifecycle",
  "input",
];

/**
 * Adapts the SDK's remote ThreadStream to the local GraphRunStream shape.
 */
export class RemoteGraphRunStream<
  TValues = Record<string, unknown>,
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> extends GraphRunStream<TValues, TExtensions> {
  readonly #client: Client;

  readonly #thread: ThreadStream<TExtensions>;

  readonly #runId: string | undefined;

  readonly #abortController: AbortController;

  constructor(params: {
    client: Client;
    thread: ThreadStream<TExtensions>;
    runId?: string;
    abortController?: AbortController;
  }) {
    const abortController = params.abortController ?? new AbortController();
    super(
      [],
      new StreamMux(),
      0,
      0,
      params.thread.extensions as TExtensions,
      abortController
    );
    this.#client = params.client;
    this.#thread = params.thread;
    this.#runId = params.runId;
    this.#abortController = abortController;
  }

  override [Symbol.asyncIterator](): AsyncIterator<ProtocolEvent> {
    return this.#iterateEvents()[Symbol.asyncIterator]();
  }

  override get subgraphs(): AsyncIterable<SubgraphRunStream> {
    const subgraphs = this.#thread.subgraphs as unknown;
    return subgraphs as AsyncIterable<SubgraphRunStream>;
  }

  override get values(): AsyncIterable<TValues> & PromiseLike<TValues> {
    return this.#thread.values as AsyncIterable<TValues> & PromiseLike<TValues>;
  }

  override get messages(): AsyncIterable<ChatModelStreamHandle> {
    const messages = this.#thread.messages as unknown;
    return messages as AsyncIterable<ChatModelStreamHandle>;
  }

  override get lifecycle(): AsyncIterable<LifecycleEntry> {
    return this.#iterateLifecycle();
  }

  override messagesFrom(node: string): AsyncIterable<ChatModelStreamHandle> {
    const messages = this.messages;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of messages) {
          if (message.node === node) {
            yield message;
          }
        }
      },
    };
  }

  override get output(): Promise<TValues> {
    return this.#thread.output as Promise<TValues>;
  }

  override get interrupted(): boolean {
    return this.#thread.interrupted;
  }

  override get interrupts(): readonly InterruptPayload[] {
    return this.#thread.interrupts as readonly InterruptPayload[];
  }

  override abort(reason?: unknown): void {
    if (this.#abortController.signal.aborted) return;
    this.#abortController.abort(reason);
    void this.#cancelAndClose();
  }

  override get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get thread(): ThreadStream<TExtensions> {
    return this.#thread;
  }

  async #cancelAndClose(): Promise<void> {
    try {
      if (this.#runId != null) {
        await this.#client.runs.cancel(
          this.#thread.threadId,
          this.#runId,
          false
        );
      }
    } catch {
      // Best effort: closing the ThreadStream still releases client resources.
    }
    try {
      await this.#thread.close();
    } catch {
      // Best effort.
    }
  }

  async *#iterateEvents(): AsyncGenerator<ProtocolEvent> {
    const subscription = await this.#thread.subscribe({
      channels: REMOTE_V3_CHANNELS,
    });
    try {
      for await (const event of subscription) {
        yield event as unknown as ProtocolEvent;
      }
    } finally {
      await subscription.unsubscribe();
    }
  }

  async *#iterateLifecycle(): AsyncGenerator<LifecycleEntry> {
    const subscription = await this.#thread.subscribe({
      channels: ["lifecycle"],
    });
    try {
      for await (const event of subscription) {
        yield eventToLifecycleEntry(event);
      }
    } finally {
      await subscription.unsubscribe();
    }
  }
}

function eventToLifecycleEntry(event: Event): LifecycleEntry {
  return {
    ...(event.params.data as Record<string, unknown>),
    namespace: event.params.namespace,
    timestamp: event.params.timestamp,
  } as LifecycleEntry;
}
