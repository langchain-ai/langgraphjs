import type {
  Command,
  CommandResponse,
  Event,
  Message,
  SubscribeParams,
} from "@langchain/protocol";

import { matchesSubscription } from "../subscription.js";
import type { TransportAdapter, EventStreamHandle } from "../transport.js";

export class MockTransport implements TransportAdapter {
  readonly threadId: string;
  private readonly eventQueue: Message[] = [];
  private readonly waiters: Array<(result: IteratorResult<Message>) => void> =
    [];
  readonly sentCommands: Command[] = [];
  closed = false;

  constructor(options?: { threadId?: string }) {
    this.threadId = options?.threadId ?? "thread_test";
  }

  async open(): Promise<void> {
    // no-op for the mock
  }

  async send(command: Command): Promise<CommandResponse> {
    this.sentCommands.push(command);

    switch (command.method) {
      case "subscription.subscribe":
        return {
          type: "success",
          id: command.id,
          result: { subscription_id: `sub_${command.id}` },
        };
      case "subscription.unsubscribe":
        return {
          type: "success",
          id: command.id,
          result: {},
        };
      case "run.input":
        return {
          type: "success",
          id: command.id,
          result: { run_id: "run_1" },
          meta: { applied_through_seq: 9 },
        };
      default:
        return {
          type: "success",
          id: command.id,
          result: {},
        };
    }
  }

  pushEvent(event: Event): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: false, value: event });
      return;
    }
    this.eventQueue.push(event);
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  events(): AsyncIterable<Message> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Message>> => {
          if (this.eventQueue.length > 0) {
            return { done: false, value: this.eventQueue.shift()! };
          }
          if (this.closed) {
            return { done: true, value: undefined };
          }
          return await new Promise<IteratorResult<Message>>((resolve) => {
            this.waiters.push(resolve);
          });
        },
        return: async () => {
          await this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

/**
 * Mock SSE-style transport: each subscription gets its own filtered stream
 * (via `openEventStream`) with a replay buffer, mirroring
 * `ProtocolSseTransportAdapter`. Every pushed event is stored in the buffer
 * and fanned out to every open stream whose filter matches — so opening
 * a second subscription replays all prior matching events, exactly like
 * the real server.
 */
export class MockSseTransport implements TransportAdapter {
  readonly threadId: string;
  readonly sentCommands: Command[] = [];
  closed = false;

  private readonly buffer: Event[] = [];
  private readonly streams = new Set<{
    params: SubscribeParams;
    push: (event: Event) => void;
    closed: boolean;
  }>();

  constructor(options?: { threadId?: string }) {
    this.threadId = options?.threadId ?? "thread_test";
  }

  async open(): Promise<void> {
    // no-op for the mock
  }

  async send(command: Command): Promise<CommandResponse> {
    this.sentCommands.push(command);
    switch (command.method) {
      case "run.input":
        return {
          type: "success",
          id: command.id,
          result: { run_id: "run_1" },
          meta: { applied_through_seq: 9 },
        };
      default:
        return {
          type: "success",
          id: command.id,
          result: {},
        };
    }
  }

  events(): AsyncIterable<Message> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  openEventStream(params: SubscribeParams): EventStreamHandle {
    const queue: Message[] = [];
    const waiters: Array<(result: IteratorResult<Message>) => void> = [];
    const stream = {
      params,
      closed: false,
      push: (event: Event) => {
        if (stream.closed) return;
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ done: false, value: event });
          return;
        }
        queue.push(event);
      },
    };
    this.streams.add(stream);

    for (const event of this.buffer) {
      if (matchesSubscription(event, params)) {
        stream.push(event);
      }
    }

    const close = () => {
      if (stream.closed) return;
      stream.closed = true;
      this.streams.delete(stream);
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    };

    return {
      ready: Promise.resolve(),
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Message>> => {
            if (queue.length > 0) {
              return { done: false, value: queue.shift()! };
            }
            if (stream.closed) {
              return { done: true, value: undefined };
            }
            return await new Promise<IteratorResult<Message>>((resolve) => {
              waiters.push(resolve);
            });
          },
          return: async () => {
            close();
            return { done: true, value: undefined };
          },
        }),
      },
      close,
    };
  }

  /**
   * Broadcast an event to all matching open streams and add it to the
   * buffer for later-attaching subscriptions (server-replay simulation).
   */
  pushEvent(event: Event): void {
    this.buffer.push(event);
    for (const stream of this.streams) {
      if (stream.closed) continue;
      if (matchesSubscription(event, stream.params)) {
        stream.push(event);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stream of Array.from(this.streams)) {
      stream.closed = true;
    }
    this.streams.clear();
  }
}

export function eventOf(
  method: Event["method"],
  channelData: Event extends infer T
    ? T extends { method: typeof method; params: { data: infer D } }
      ? D
      : never
    : never,
  options: {
    namespace?: string[];
    node?: string;
    seq?: number;
    eventId?: string;
  } = {}
): Event {
  return {
    type: "event",
    method,
    seq: options.seq,
    event_id: options.eventId,
    params: {
      namespace: options.namespace ?? [],
      timestamp: Date.now(),
      ...(options.node ? { node: options.node } : {}),
      data: channelData,
    },
  } as Event;
}

export async function nextValue<T>(iterable: AsyncIterable<T>): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done) {
    throw new Error("Expected an event but iterator completed");
  }
  return result.value;
}
