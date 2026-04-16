import type { Event, MessagesEvent, SubscribeParams } from "@langchain/protocol";
import type { SubscriptionHandle } from "../index.js";
import { MessageAssembler, StreamingMessageAssembler } from "../messages.js";
import type { AssembledMessage, StreamingMessage } from "../messages.js";
import type { MessageSubscription } from "../types.js";

/**
 * Async iterable handle that assembles raw `messages` events into complete
 * `AssembledMessage` instances (snapshot-based, yields on message-finish).
 */
export class MessageSubscriptionHandle
  implements AsyncIterable<AssembledMessage>, MessageSubscription
{
  readonly params: SubscribeParams;
  readonly subscriptionId: string;
  private readonly source: SubscriptionHandle<Event>;
  private readonly assembler = new MessageAssembler();
  private readonly queue: AssembledMessage[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<AssembledMessage>) => void
  > = [];
  private sourcePump?: Promise<void>;
  private closed = false;

  constructor(source: SubscriptionHandle<Event>) {
    this.source = source;
    this.subscriptionId = source.subscriptionId;
    this.params = source.params;
  }

  private start(): void {
    if (this.sourcePump) {
      return;
    }
    this.sourcePump = (async () => {
      for await (const event of this.source) {
        if (event.method !== "messages") {
          continue;
        }
        const update = this.assembler.consume(event);
        if (
          update.kind === "message-finish" ||
          update.kind === "message-error"
        ) {
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter({ done: false, value: update.message });
          } else {
            this.queue.push(update.message);
          }
        }
      }
      this.closed = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async unsubscribe(): Promise<void> {
    this.closed = true;
    await this.source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<AssembledMessage> {
    this.start();
    return {
      next: async () => {
        if (this.queue.length > 0) {
          return { done: false, value: this.queue.shift()! };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<AssembledMessage>>(
          (resolve) => {
            this.waiters.push(resolve);
          }
        );
      },
      return: async () => {
        await this.unsubscribe();
        return { done: true, value: undefined };
      },
    };
  }
}

/**
 * Async iterable handle that assembles raw `messages` events into
 * {@link StreamingMessage} instances with live text/reasoning deltas.
 *
 * Mirrors the in-process `run.messages` which yields `ChatModelStream`.
 */
export class StreamingMessageSubscriptionHandle
  implements AsyncIterable<StreamingMessage>
{
  readonly params;
  readonly subscriptionId: string;
  private readonly source: SubscriptionHandle<Event>;
  private readonly assembler = new StreamingMessageAssembler();
  private readonly queue: StreamingMessage[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<StreamingMessage>) => void
  > = [];
  private sourcePump?: Promise<void>;
  private closed = false;

  constructor(source: SubscriptionHandle<Event>) {
    this.source = source;
    this.subscriptionId = source.subscriptionId;
    this.params = source.params;
  }

  private start(): void {
    if (this.sourcePump) return;
    this.sourcePump = (async () => {
      for await (const event of this.source) {
        if (event.method !== "messages") continue;
        const streaming = this.assembler.consume(event as MessagesEvent);
        if (streaming) {
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter({ done: false, value: streaming });
          } else {
            this.queue.push(streaming);
          }
        }
      }
      this.closed = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async unsubscribe(): Promise<void> {
    this.closed = true;
    await this.source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingMessage> {
    this.start();
    return {
      next: async () => {
        if (this.queue.length > 0) {
          return { done: false, value: this.queue.shift()! };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<StreamingMessage>>(
          (resolve) => {
            this.waiters.push(resolve);
          }
        );
      },
      return: async () => {
        await this.unsubscribe();
        return { done: true, value: undefined };
      },
    };
  }
}
