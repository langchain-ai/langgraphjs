import type { Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  SubagentHandle,
  SubgraphHandle,
  SubscriptionHandle,
  ThreadStream,
} from "./index.js";
import { ToolCallAssembler } from "./handles/tools.js";
import type { ThreadExtension } from "./types.js";
import {
  MockSseTransport,
  MockTransport,
  eventOf,
  nextValue,
} from "./test/utils.js";

describe("ThreadStream", () => {
  it("routes subscribed events by channel and namespace", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const subscription = await thread.subscribe({
      channels: ["messages"],
      namespaces: [["agent_1"]],
    });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_1" },
        { namespace: ["agent_1"], node: "planner", seq: 1, eventId: "evt_1" }
      )
    );

    const received = await nextValue(subscription);
    expect(received.method).toBe("messages");
    expect(received.params.namespace).toEqual(["agent_1"]);
    expect(thread.ordering.lastSeenSeq).toBe(1);
    expect(thread.ordering.lastEventId).toBe("evt_1");
  });

  it("assembles complete messages via thread.messages getter", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const messages = thread.messages;
    // Let the getter's underlying subscribe command register.
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_final" },
        { namespace: [], node: "agent", seq: 3, eventId: "evt_3" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "text", text: "" },
        },
        { namespace: [], node: "agent", seq: 4, eventId: "evt_4" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "Hello " },
        },
        { namespace: [], node: "agent", seq: 5, eventId: "evt_5" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "world" },
        },
        { namespace: [], node: "agent", seq: 6, eventId: "evt_6" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content: { type: "text", text: "Hello world" },
        },
        { namespace: [], node: "agent", seq: 7, eventId: "evt_7" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
          usage: { total_tokens: 4 },
        },
        { namespace: [], node: "agent", seq: 8, eventId: "evt_8" }
      )
    );

    const msg = await nextValue(messages);
    const fullText = await msg.text;
    expect(fullText).toBe("Hello world");
    expect((await msg.usage)?.total_tokens).toBe(4);
  });

  it("tracks applied_through_seq on command responses", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "my-agent" });

    await thread.run.start({ input: {} });
    expect(thread.ordering.lastAppliedThroughSeq).toBe(9);
  });

  it("requires an assistantId at construction", () => {
    const transport = new MockTransport();
    expect(
      () => new ThreadStream(transport, { assistantId: "" })
    ).toThrow(/assistantId/);
  });

  it("sends the bound assistantId on every run.start", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, {
      assistantId: "bound-agent",
    });

    await thread.run.start({ input: { step: 1 } });
    await thread.run.start({ input: { step: 2 } });

    const runInputs = transport.sentCommands.filter(
      (c) => c.method === "run.start"
    );
    expect(runInputs).toHaveLength(2);
    for (const cmd of runInputs) {
      expect(
        (cmd.params as { assistant_id: string }).assistant_id
      ).toBe("bound-agent");
    }
  });

  it("exposes the bound assistantId as thread.assistantId", () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, {
      assistantId: "my-agent",
    });
    expect(thread.assistantId).toBe("my-agent");
  });

  it("closes thread cleanly", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    await thread.close();
    expect(transport.closed).toBe(true);
  });

  it("unsubscribes and sends unsubscribe command", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const subscription = await thread.subscribe({ channels: ["messages"] });
    await subscription.unsubscribe();

    expect(
      transport.sentCommands.filter(
        (c) => c.method === "subscription.unsubscribe"
      )
    ).toHaveLength(1);
  });

  it("exposes the transport thread ID", () => {
    const transport = new MockTransport({ threadId: "my-thread" });
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    expect(thread.threadId).toBe("my-thread");
  });
});

describe("SubscriptionHandle", () => {
  it("delivers pushed events through the async iterator", async () => {
    const handle = new SubscriptionHandle<Event>(
      "sub_1",
      { channels: ["messages"] },
      async () => {}
    );
    handle.push(
      eventOf(
        "messages",
        { event: "message-start", id: "m1" },
        { namespace: [], eventId: "e1" }
      )
    );
    const value = await nextValue(handle);
    expect(value.event_id).toBe("e1");
  });

  it("resolves waiting iterators when closed", async () => {
    const handle = new SubscriptionHandle<Event>(
      "sub_2",
      { channels: ["messages"] },
      async () => {}
    );
    const iterator = handle[Symbol.asyncIterator]();
    const pending = iterator.next();
    handle.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("ignores events pushed after close", async () => {
    const handle = new SubscriptionHandle<Event>(
      "sub_3",
      { channels: ["messages"] },
      async () => {}
    );
    handle.close();
    handle.push(
      eventOf(
        "messages",
        { event: "message-start", id: "m" },
        { namespace: [] }
      )
    );
    const iterator = handle[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });
});

describe("custom:name subscriptions", () => {
  it("unwraps named custom events to raw payload", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const sub = await thread.subscribe("custom:a2a");

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "a2a", payload: { hello: "world" } },
        { namespace: [], seq: 1 }
      )
    );

    const received = await nextValue(sub);
    expect(received).toEqual({ hello: "world" });
  });

  it("delivers full events for plain 'custom' subscriptions", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const sub = await thread.subscribe("custom");
    transport.pushEvent(
      eventOf(
        "custom",
        { name: "other", payload: { x: 1 } },
        { namespace: [], seq: 1 }
      )
    );

    const received = await nextValue(sub);
    expect((received as Event).method).toBe("custom");
  });
});

describe("thread.extensions projection", () => {
  it("streams payloads via AsyncIterable and resolves the last value on run end", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream<{ toolActivity: { step: number } }>(
      transport,
      { assistantId: "test-agent" }
    );

    const activity = thread.extensions.toolActivity;
    // Let the proxy's underlying subscribe command register.
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "toolActivity", payload: { step: 1 } },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "custom",
        { name: "toolActivity", payload: { step: 2 } },
        { namespace: [], seq: 2 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 3 }
      )
    );

    const items: unknown[] = [];
    for await (const item of activity) {
      items.push(item);
    }

    expect(items).toEqual([{ step: 1 }, { step: 2 }]);
    await expect(activity).resolves.toEqual({ step: 2 });
  });

  it("resolves final-value transformers via the PromiseLike interface", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream<{ toolCallCount: number }>(transport, {
      assistantId: "test-agent",
    });

    const toolCallCount = thread.extensions.toolCallCount;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "toolCallCount", payload: 7 },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 2 }
      )
    );

    await expect(toolCallCount).resolves.toBe(7);
  });

  it("ignores custom events with a different name", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const foo = thread.extensions.foo;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "bar", payload: "other" },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "custom",
        { name: "foo", payload: "mine" },
        { namespace: [], seq: 2 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 3 }
      )
    );

    const items: unknown[] = [];
    for await (const item of foo) {
      items.push(item);
    }
    expect(items).toEqual(["mine"]);
  });

  it("caches per-name handles on repeated access", () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const first = thread.extensions.stats;
    const second = thread.extensions.stats;
    const other = thread.extensions.other;

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("accepts the in-process projection shape and unwraps it", async () => {
    // Typed with the in-process shape that
    // `graph.streamEvents(..., { version: "v3" })` / `run.extensions`
    // returns — `Promise<number>` for a final-value
    // transformer, `AsyncIterable<{ step: number }>` for a streaming
    // transformer. `ThreadStream` should unwrap these to their payload
    // types so users don't have to redeclare them.
    interface InProcessShape extends Record<string, unknown> {
      toolCallCount: Promise<number>;
      activity: AsyncIterable<{ step: number }>;
    }

    const transport = new MockTransport();
    const thread = new ThreadStream<InProcessShape>(transport, {
      assistantId: "test-agent",
    });

    // Compile-time assertion: the handles are typed off the unwrapped
    // payload, not the wrapper.
    const _count: ThreadExtension<number> = thread.extensions.toolCallCount;
    const _activity: ThreadExtension<{ step: number }> =
      thread.extensions.activity;
    void _count;
    void _activity;

    void thread.extensions.toolCallCount;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "toolCallCount", payload: 42 },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 2 }
      )
    );

    await expect(thread.extensions.toolCallCount).resolves.toBe(42);
  });

  it("resolves when accessed after the run has already ended", async () => {
    // `MockSseTransport` mirrors the real server: each subscription
    // opens its own stream and replays buffered events matching the
    // filter. This is exactly what lets the lazy extensions dispatcher
    // still observe custom events emitted before the dispatcher was
    // opened.
    const transport = new MockSseTransport();
    const thread = new ThreadStream<{ toolCallCount: number }>(transport, {
      assistantId: "test-agent",
    });

    // Simulate a complete run without any prior extension access: the
    // user only grabs `thread.extensions.toolCallCount` after
    // `run.start` has returned and the run has terminated.
    await thread.run.start({ input: {} });

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "toolCallCount", payload: 11 },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 2 }
      )
    );

    await expect(thread.extensions.toolCallCount).resolves.toBe(11);
  });

  it("replays buffered events into late-constructed handles via the server buffer", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream<{ activity: { step: number } }>(transport, {
      assistantId: "test-agent",
    });

    await thread.run.start({ input: {} });

    transport.pushEvent(
      eventOf(
        "custom",
        { name: "activity", payload: { step: 1 } },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "custom",
        { name: "activity", payload: { step: 2 } },
        { namespace: [], seq: 2 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: [], seq: 3 }
      )
    );

    // User grabs the handle *after* every event has already been
    // broadcast. Under the lazy dispatcher model, server replay
    // delivers the full event history to the new subscription.
    const activity = thread.extensions.activity;

    const items: unknown[] = [];
    for await (const item of activity) {
      items.push(item);
    }
    expect(items).toEqual([{ step: 1 }, { step: 2 }]);
    await expect(activity).resolves.toEqual({ step: 2 });
  });
});

describe("ProtocolError", () => {
  it("wraps error response with code and message", () => {
    const err = new ProtocolError({
      type: "error",
      id: 1,
      error: "invalid_argument",
      message: "bad params",
    });
    expect(err.code).toBe("invalid_argument");
    expect(err.message).toBe("bad params");
  });
});

describe("ToolCallAssembler", () => {
  it("assembles tool-started into AssembledToolCall with promise lifecycle", async () => {
    const assembler = new ToolCallAssembler();
    const started = assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "tc_1",
          tool_name: "search",
          input: { q: "hello" },
        },
        { namespace: [], seq: 1 }
      ) as never
    );
    expect(started?.name).toBe("search");
    expect(started?.callId).toBe("tc_1");
    expect(started?.input).toEqual({ q: "hello" });

    assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-finished",
          tool_call_id: "tc_1",
          output: { result: "ok" },
        },
        { namespace: [], seq: 2 }
      ) as never
    );

    await expect(started!.output).resolves.toEqual({ result: "ok" });
    await expect(started!.status).resolves.toBe("finished");
  });

  it("resolves error status on tool-error", async () => {
    const assembler = new ToolCallAssembler();
    const started = assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "tc_e",
          tool_name: "bad",
          input: {},
        },
        { namespace: [], seq: 1 }
      ) as never
    );
    assembler.consume(
      eventOf(
        "tools",
        { event: "tool-error", tool_call_id: "tc_e", message: "boom" },
        { namespace: [], seq: 2 }
      ) as never
    );
    await expect(started!.output).rejects.toThrow("boom");
    await expect(started!.status).resolves.toBe("error");
  });

  it("ignores tool-output-delta events (returns undefined)", () => {
    const assembler = new ToolCallAssembler();
    const result = assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-output-delta",
          tool_call_id: "tc",
          output_delta: "partial",
        },
        { namespace: [], seq: 1 }
      ) as never
    );
    expect(result).toBeUndefined();
  });
});

describe("thread.toolCalls projection", () => {
  it("yields assembled tool calls through the getter", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const tools = thread.toolCalls;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "tc_sub_1",
          tool_name: "calculator",
          input: { a: 3, b: 4 },
        },
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-finished",
          tool_call_id: "tc_sub_1",
          output: { result: 7 },
        },
        { namespace: [], seq: 2 }
      )
    );

    const tc = await nextValue(tools);
    expect(tc.name).toBe("calculator");
    expect(tc.callId).toBe("tc_sub_1");
    expect(tc.input).toEqual({ a: 3, b: 4 });
    await expect(tc.output).resolves.toEqual({ result: 7 });
    await expect(tc.status).resolves.toBe("finished");
  });
});

describe("thread.values projection", () => {
  it("extracts state data from values events", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const values = thread.values;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "values",
        {
          messages: [{ role: "user", content: "hi" }],
          count: 1,
        },
        { namespace: [], seq: 1 }
      )
    );

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({
      messages: [{ role: "user", content: "hi" }],
      count: 1,
    });
  });

  it("resolves output promise with final value on close", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    void thread.values;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf("values", { step: 1 }, { namespace: [], seq: 1 })
    );
    transport.pushEvent(
      eventOf("values", { step: 2 }, { namespace: [], seq: 2 })
    );

    await new Promise((r) => setTimeout(r, 10));
    await transport.close();

    const final = await thread.output;
    expect(final).toEqual({ step: 2 });
  });
});

describe("thread.subgraphs projection", () => {
  it("discovers subgraphs from lifecycle started events", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const iter = thread.subgraphs[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "lifecycle",
        {
          event: "started",
          graph_name: "researcher",
          cause: { type: "toolCall", tool_call_id: "call_abc" },
        },
        { namespace: ["researcher:0"], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "started", graph_name: "coder" },
        { namespace: ["coder:1"], seq: 2 }
      )
    );

    const first = (await iter.next()).value as SubgraphHandle;
    expect(first.name).toBe("researcher");
    expect(first.index).toBe(0);
    expect(first.namespace).toEqual(["researcher:0"]);
    expect(first.cause).toEqual({ type: "toolCall", tool_call_id: "call_abc" });
    expect(first.graphName).toBe("researcher");

    const second = (await iter.next()).value as SubgraphHandle;
    expect(second.name).toBe("coder");
    expect(second.index).toBe(1);
    expect(second.namespace).toEqual(["coder:1"]);
    expect(second.cause).toBeUndefined();
  });

  it("attaches tool-started events observed before caused subgraphs", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subgraphs[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "call_before",
          tool_name: "task",
          input: { description: "Research", subagent_type: "researcher" },
        } as Event["params"]["data"],
        { namespace: [], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        {
          event: "started",
          graph_name: "researcher",
          cause: { type: "toolCall", tool_call_id: "call_before" },
        },
        { namespace: ["researcher:0"], seq: 2 }
      )
    );

    const sub = (await iter.next()).value as SubgraphHandle;
    expect(sub.name).toBe("researcher");
    expect(sub.cause).toEqual({
      type: "toolCall",
      tool_call_id: "call_before",
    });
    expect(sub.toolStartedEvent?.params.data).toMatchObject({
      event: "tool-started",
      tool_call_id: "call_before",
      tool_name: "task",
    });
  });

  it("attaches tool-started events observed after caused subgraphs", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subgraphs[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "lifecycle",
        {
          event: "started",
          graph_name: "researcher",
          cause: { type: "toolCall", tool_call_id: "call_after" },
        },
        { namespace: ["researcher:0"], seq: 1 }
      )
    );

    const sub = (await iter.next()).value as SubgraphHandle;
    expect(sub.cause).toEqual({
      type: "toolCall",
      tool_call_id: "call_after",
    });
    expect(sub.toolStartedEvent).toBeUndefined();

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "call_after",
          tool_name: "task",
          input: { description: "Research", subagent_type: "researcher" },
        } as Event["params"]["data"],
        { namespace: [], seq: 2 }
      )
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(sub.toolStartedEvent?.params.data).toMatchObject({
      event: "tool-started",
      tool_call_id: "call_after",
      tool_name: "task",
    });
  });

  it("ignores non-started lifecycle events", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subgraphs[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" },
        { namespace: ["researcher:0"], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "started", graph_name: "worker" },
        { namespace: ["worker:0"], seq: 2 }
      )
    );

    const first = (await iter.next()).value as SubgraphHandle;
    expect(first.name).toBe("worker");
  });

  it("deduplicates same namespace", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subgraphs[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "started", graph_name: "worker" },
        { namespace: ["worker:0"], seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "started", graph_name: "worker" },
        { namespace: ["worker:0"], seq: 2 }
      )
    );
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "started", graph_name: "other" },
        { namespace: ["other:0"], seq: 3 }
      )
    );

    const first = (await iter.next()).value as SubgraphHandle;
    expect(first.name).toBe("worker");
    const second = (await iter.next()).value as SubgraphHandle;
    expect(second.name).toBe("other");
  });
});

describe("thread.messages projection", () => {
  it("yields StreamingMessage with text deltas and final text", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const messages = thread.messages;
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "m1" },
        { namespace: [], node: "agent", seq: 1 }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "text", text: "" },
        },
        { namespace: [], node: "agent", seq: 2 }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "Hello" },
        },
        { namespace: [], node: "agent", seq: 3 }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content: { type: "text", text: "Hello" },
        },
        { namespace: [], node: "agent", seq: 4 }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-finish", reason: "stop" },
        { namespace: [], node: "agent", seq: 5 }
      )
    );

    const msg = await nextValue(messages);
    expect(msg.node).toBe("agent");
    const text = await msg.text;
    expect(text).toBe("Hello");
  });
});

describe("thread.subagents projection", () => {
  it("discovers subagents from task tool-started events", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subagents[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "task_1",
          tool_name: "task",
          input: {
            description: "Research AI trends",
            subagent_type: "researcher",
          },
        } as Event["params"]["data"],
        { namespace: [], seq: 1 }
      )
    );

    const first = (await iter.next()).value as SubagentHandle;
    expect(first.name).toBe("researcher");
    expect(first.callId).toBe("task_1");
    await expect(first.taskInput).resolves.toBe("Research AI trends");
  });

  it("resolves output on tool-finished", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subagents[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "task_r",
          tool_name: "task",
          input: { description: "Research", subagent_type: "researcher" },
        } as Event["params"]["data"],
        { namespace: [], seq: 1 }
      )
    );

    const sub = (await iter.next()).value as SubagentHandle;

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-finished",
          tool_call_id: "task_r",
          output: { result: "AI is growing fast" },
        } as Event["params"]["data"],
        { namespace: [], seq: 2 }
      )
    );

    await expect(sub.output).resolves.toEqual({
      result: "AI is growing fast",
    });
  });

  it("rejects output on tool-error", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });
    const iter = thread.subagents[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "task_e",
          tool_name: "task",
          input: { description: "Fail", subagent_type: "broken" },
        } as Event["params"]["data"],
        { namespace: [], seq: 1 }
      )
    );

    const sub = (await iter.next()).value as SubagentHandle;

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-error",
          tool_call_id: "task_e",
          message: "Subagent crashed",
        } as Event["params"]["data"],
        { namespace: [], seq: 2 }
      )
    );

    await expect(sub.output).rejects.toThrow("Subagent crashed");
  });
});

describe("SSE transport: per-stream delivery", () => {
  // Regression: in SSE mode each subscription gets its own server-filtered
  // stream (and the server replays matching events on attach). The client
  // must deliver each stream's events only to its owning subscription —
  // otherwise later-attaching narrower subscriptions cause the same event
  // to be re-dispatched to broader subscriptions (e.g. `thread.subagents`),
  // producing duplicate discoveries and out-of-order message assembly.
  it("does not duplicate subagent discovery when a narrower subscription opens later", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const iter = thread.subagents[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 0));

    transport.pushEvent(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "task_1",
          tool_name: "task",
          input: { description: "do work", subagent_type: "worker" },
        } as never,
        { namespace: ["tools:uuid1"], seq: 1, eventId: "evt_1" }
      )
    );

    const sub = (await iter.next()).value as SubagentHandle;
    expect(sub.name).toBe("worker");

    // Opening the narrower `sub.toolCalls` subscription triggers a server
    // replay of the same `tool-started` event on a new SSE stream.
    void sub.toolCalls;
    await new Promise((r) => setTimeout(r, 10));

    // Before the fix, the replayed event would be fanned back into the
    // `thread.subagents` subscription, producing a duplicate handle.
    const next = await Promise.race([
      iter.next(),
      new Promise<null>((r) => setTimeout(() => r(null), 20)),
    ]);
    expect(next).toBeNull();
  });

  it("dedupes thread.interrupts when the same event reaches multiple streams", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    // Two subscriptions both matching `input.requested` events so the
    // same event is delivered on two independent SSE streams.
    await thread.subscribe({ channels: ["input"] });
    await thread.subscribe({ channels: ["input"] });

    transport.pushEvent(
      eventOf(
        "input.requested" as never,
        {
          interrupt_id: "int_1",
          payload: { action: "approve" },
        } as never,
        { namespace: [], seq: 1, eventId: "evt_int_1" }
      )
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(thread.interrupts).toHaveLength(1);
    expect(thread.interrupts[0].interruptId).toBe("int_1");
  });
});

describe("interrupts", () => {
  it("tracks interrupted state from lifecycle events", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const sub = await thread.subscribe({ channels: ["lifecycle"] });

    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "interrupted" },
        { namespace: [], seq: 1 }
      )
    );

    await nextValue(sub);
    expect(thread.interrupted).toBe(true);
  });

  it("captures input.requested events into thread.interrupts", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const sub = await thread.subscribe({ channels: ["input"] });

    transport.pushEvent(
      eventOf(
        "input.requested" as never,
        {
          interrupt_id: "int_1",
          payload: { action: "approve" },
        } as never,
        { namespace: [], seq: 1 }
      )
    );

    await nextValue(sub);
    expect(thread.interrupts).toHaveLength(1);
    expect(thread.interrupts[0].interruptId).toBe("int_1");
    expect(thread.interrupts[0].payload).toEqual({ action: "approve" });
  });

  it("run.start resets interrupted state", async () => {
    const transport = new MockTransport();
    const thread = new ThreadStream(transport, { assistantId: "test-agent" });

    const sub = await thread.subscribe({ channels: ["lifecycle"] });
    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "interrupted" },
        { namespace: [], seq: 1 }
      )
    );
    await nextValue(sub);
    expect(thread.interrupted).toBe(true);

    await thread.run.start({ input: {} });
    expect(thread.interrupted).toBe(false);
    expect(thread.interrupts).toHaveLength(0);
  });
});
