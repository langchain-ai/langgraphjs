import type {
  Command,
  CommandResponse,
  Event,
  Message,
  SessionOpenParams,
  SessionResult,
} from "@langchain/protocol";

import type { TransportAdapter } from "../transport.js";

export class MockTransport implements TransportAdapter {
  private readonly eventQueue: Message[] = [];
  private readonly waiters: Array<(result: IteratorResult<Message>) => void> =
    [];
  readonly sentCommands: Command[] = [];
  readonly sessionResult: SessionResult;
  closed = false;

  constructor(sessionResult?: Partial<SessionResult>) {
    this.sessionResult = {
      session_id: "sess_test",
      protocol_version: "0.3.0",
      transport: {
        name: "in-process",
        event_ordering: "seq",
        command_delivery: "direct-call",
      },
      capabilities: {
        modules: [
          {
            name: "session",
            commands: ["open", "describe", "close"],
          },
          {
            name: "subscription",
            commands: ["subscribe", "unsubscribe", "reconnect"],
          },
          {
            name: "run",
            commands: ["input"],
          },
          {
            name: "agent",
            commands: ["getTree"],
            channels: ["lifecycle"],
          },
          {
            name: "messages",
            channels: ["messages"],
          },
          {
            name: "tools",
            channels: ["tools"],
          },
          {
            name: "usage",
            commands: ["setBudget"],
            channels: ["usage"],
          },
        ],
      },
      ...sessionResult,
    };
  }

  async open(_params: SessionOpenParams): Promise<SessionResult> {
    return this.sessionResult;
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
      case "session.close":
      case "usage.setBudget":
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
      case "subscription.reconnect":
        return {
          type: "success",
          id: command.id,
          result: { restored: true, missed_events: 2 },
        };
      case "session.describe":
        return {
          type: "success",
          id: command.id,
          result: this.sessionResult,
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
