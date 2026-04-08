import type {
  Channel,
  Command,
  CommandResponse,
  Event,
  Message,
  SessionOpenParams,
  SessionResult,
  SubscribeParams,
} from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import { MessageAssembler } from "../src/messages.js";
import { ProtocolClient } from "../src/session.js";
import type { TransportAdapter } from "../src/transport.js";

class MockTransport implements TransportAdapter {
  private readonly eventQueue: Message[] = [];
  private readonly waiters: Array<(result: IteratorResult<Message>) => void> = [];
  readonly sentCommands: Command[] = [];
  readonly sessionResult: SessionResult;
  closed = false;

  constructor(sessionResult?: Partial<SessionResult>) {
    this.sessionResult = {
      sessionId: "sess_test",
      protocolVersion: "0.3.0",
      transport: {
        name: "in-process",
        eventOrdering: "seq",
        commandDelivery: "direct-call",
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
          result: { subscriptionId: `sub_${command.id}` },
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
          result: { runId: "run_1" },
          meta: { appliedThroughSeq: 9 },
        };
      case "subscription.reconnect":
        return {
          type: "success",
          id: command.id,
          result: { restored: true, missedEvents: 2 },
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

function eventOf(
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
  } = {},
): Event {
  return {
    type: "event",
    method,
    seq: options.seq,
    eventId: options.eventId,
    params: {
      namespace: options.namespace ?? [],
      timestamp: Date.now(),
      ...(options.node ? { node: options.node } : {}),
      data: channelData,
    },
  } as Event;
}

async function nextValue<T>(iterable: AsyncIterable<T>): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done) {
    throw new Error("Expected an event but iterator completed");
  }
  return result.value;
}

describe("ProtocolClient", () => {
  it("opens a session and routes subscribed events by channel and namespace", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocolVersion: "0.3.0" });

    const subscription = await session.subscribe({
      channels: ["messages"],
      namespaces: [["agent_1"]],
    });

    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "message-start",
          messageId: "msg_1",
        },
        {
          namespace: ["agent_1"],
          node: "planner",
          seq: 1,
          eventId: "evt_1",
        },
      ),
    );

    const received = await nextValue(subscription);
    expect(received.method).toBe("messages");
    expect(received.params.namespace).toEqual(["agent_1"]);
    expect(session.ordering.lastSeenSeq).toBe(1);
    expect(session.ordering.lastEventId).toBe("evt_1");
  });

  it("replays buffered events when a later subscription matches them", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocolVersion: "0.3.0" });

    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "message-start",
          messageId: "msg_early",
        },
        {
          namespace: ["agent_2"],
          node: "writer",
          seq: 2,
          eventId: "evt_early",
        },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const subscription = await session.subscribe({
      channels: ["messages"],
      namespaces: [["agent_2"]],
    });

    const replayed = await nextValue(subscription);
    expect(replayed.eventId).toBe("evt_early");
  });

  it("assembles complete messages from lifecycle events", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocolVersion: "0.3.0" });

    const messages = await session.subscribeMessages({ namespaces: [[]] });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", messageId: "msg_final" },
        { namespace: [], node: "agent", seq: 3, eventId: "evt_3" },
      ),
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "text", text: "" },
        },
        { namespace: [], node: "agent", seq: 4, eventId: "evt_4" },
      ),
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "Hello " },
        },
        { namespace: [], node: "agent", seq: 5, eventId: "evt_5" },
      ),
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "world" },
        },
        { namespace: [], node: "agent", seq: 6, eventId: "evt_6" },
      ),
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          contentBlock: { type: "text", text: "Hello world" },
        },
        { namespace: [], node: "agent", seq: 7, eventId: "evt_7" },
      ),
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
          usage: { totalTokens: 4 },
        },
        { namespace: [], node: "agent", seq: 8, eventId: "evt_8" },
      ),
    );

    const assembled = await nextValue(messages);
    expect(assembled.finishReason).toBe("stop");
    expect(assembled.usage?.totalTokens).toBe(4);
    expect(assembled.blocks).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("tracks appliedThroughSeq on command responses", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocolVersion: "0.3.0" });

    const result = await session.run.input({
      input: { messages: [{ role: "user", content: "hi" }] },
    });

    expect(result.runId).toBe("run_1");
    expect(session.ordering.lastAppliedThroughSeq).toBe(9);
  });

  it("guards unsupported channels from the advertised capabilities", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
        ],
      },
    });

    const client = new ProtocolClient(transport);
    const session = await client.open({ protocolVersion: "0.3.0" });

    await expect(
      session.subscribe({ channels: ["messages"] as Channel[] }),
    ).rejects.toThrow(/not advertised/);
  });
});

describe("MessageAssembler", () => {
  it("merges text and tool chunk deltas into final message state", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", messageId: "msg_x" }, {
        namespace: ["agent_1"],
        node: "writer",
      }) as Extract<Event, { method: "messages" }>,
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "tool_call_chunk", name: "search", args: "" },
        },
        {
          namespace: ["agent_1"],
          node: "writer",
        },
      ) as Extract<Event, { method: "messages" }>,
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "tool_call_chunk", args: "{\"q\":" },
        },
        {
          namespace: ["agent_1"],
          node: "writer",
        },
      ) as Extract<Event, { method: "messages" }>,
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "tool_call_chunk", args: "\"test\"}" },
        },
        {
          namespace: ["agent_1"],
          node: "writer",
        },
      ) as Extract<Event, { method: "messages" }>,
    );
    const done = assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          contentBlock: { type: "tool_call", id: "tool_1", name: "search", args: { q: "test" } },
        },
        {
          namespace: ["agent_1"],
          node: "writer",
        },
      ) as Extract<Event, { method: "messages" }>,
    );

    expect(done?.kind).toBe("content-block-finish");

    const finished = assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "tool_use",
        },
        {
          namespace: ["agent_1"],
          node: "writer",
        },
      ) as Extract<Event, { method: "messages" }>,
    );

    expect(finished?.kind).toBe("message-finish");
    expect(finished?.message.blocks[0]).toEqual({
      type: "tool_call",
      id: "tool_1",
      name: "search",
      args: { q: "test" },
    });
  });
});
