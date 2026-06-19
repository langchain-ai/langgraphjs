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
      case "run.start":
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
/**
 * Per-open record exposed via `mock.streamHandles` for test inspection.
 * Test code can inspect/toggle these to simulate server behaviours.
 */
export interface MockSseStreamRecord {
  index: number;
  params: SubscribeParams;
  closed: boolean;
  readyResolved: boolean;
  resolveReady: () => void;
  rejectReady: (err: unknown) => void;
  failPump: (err: unknown) => void;
}

export interface MockSseTransportOptions {
  threadId?: string;
  /**
   * If set, new streams open in a "pending" state — their `ready` promise
   * stays unresolved until the test calls `resolveReady(index)`.
   * Defaults to `false`: streams are ready immediately.
   */
  manualReady?: boolean;
}

export class MockSseTransport implements TransportAdapter {
  readonly threadId: string;
  readonly sentCommands: Command[] = [];
  closed = false;

  /** Every stream ever opened, in open-order. Inspected by tests. */
  readonly streamHandles: MockSseStreamRecord[] = [];

  private readonly manualReady: boolean;
  private readonly buffer: Event[] = [];
  private readonly streams = new Set<{
    record: MockSseStreamRecord;
    push: (event: Event) => void;
    pushError: (err: unknown) => void;
  }>();

  constructor(options?: MockSseTransportOptions) {
    this.threadId = options?.threadId ?? "thread_test";
    this.manualReady = options?.manualReady ?? false;
  }

  /** Number of streams currently open (not closed). */
  get activeStreamCount(): number {
    return this.streamHandles.filter((s) => !s.closed).length;
  }

  /** Number of streams ever opened. */
  get totalStreamCount(): number {
    return this.streamHandles.length;
  }

  /** The filter passed to the most recent `openEventStream` call. */
  get lastFilter(): SubscribeParams | undefined {
    return this.streamHandles.at(-1)?.params;
  }

  /**
   * Resolve the `ready` promise of the stream at `index`. Only useful when
   * constructed with `{ manualReady: true }`.
   */
  resolveReady(index: number): void {
    this.streamHandles[index]?.resolveReady();
  }

  /**
   * Reject the `ready` promise of the stream at `index`, simulating a
   * server-side open failure.
   */
  rejectReady(index: number, err: unknown): void {
    this.streamHandles[index]?.rejectReady(err);
  }

  /**
   * Simulate a mid-pump failure on the stream at `index` (e.g. the server
   * closes the connection with an error).
   */
  failStream(index: number, err: unknown): void {
    this.streamHandles[index]?.failPump(err);
  }

  async open(): Promise<void> {
    // no-op for the mock
  }

  async send(command: Command): Promise<CommandResponse> {
    this.sentCommands.push(command);
    switch (command.method) {
      case "run.start":
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
    let rejectedWith: unknown | undefined;
    const index = this.streamHandles.length;

    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const record: MockSseStreamRecord = {
      index,
      params,
      closed: false,
      readyResolved: false,
      resolveReady: () => {
        if (record.readyResolved) return;
        record.readyResolved = true;
        resolveReady();
      },
      rejectReady: (err) => {
        if (record.readyResolved) return;
        record.readyResolved = true;
        rejectReady(err);
      },
      failPump: (err) => {
        if (record.closed) return;
        rejectedWith = err;
        const waiter = waiters.shift();
        if (waiter) {
          // Reject current waiter by surfacing an error from next()
          // — handled in the async iterator below via `rejectedWith`.
          waiter({ done: true, value: undefined });
        }
      },
    };
    this.streamHandles.push(record);

    const stream = {
      record,
      push: (event: Event) => {
        if (record.closed) return;
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ done: false, value: event });
          return;
        }
        queue.push(event);
      },
      pushError: (err: unknown) => {
        record.failPump(err);
      },
    };
    this.streams.add(stream);

    for (const event of this.buffer) {
      if (matchesSubscription(event, params)) {
        stream.push(event);
      }
    }

    if (!this.manualReady) record.resolveReady();

    const close = () => {
      if (record.closed) return;
      record.closed = true;
      this.streams.delete(stream);
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    };

    return {
      ready,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Message>> => {
            if (rejectedWith !== undefined) {
              const err = rejectedWith;
              rejectedWith = undefined;
              throw err;
            }
            if (queue.length > 0) {
              return { done: false, value: queue.shift()! };
            }
            if (record.closed) {
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
      if (stream.record.closed) continue;
      if (matchesSubscription(event, stream.record.params)) {
        stream.push(event);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stream of Array.from(this.streams)) {
      stream.record.closed = true;
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
