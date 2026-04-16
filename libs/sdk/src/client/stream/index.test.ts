import type { Channel, Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import {
  ProtocolClient,
  ProtocolError,
  SubscriptionHandle,
} from "./index.js";
import { ToolCallAssembler } from "./handles/tools.js";
import { MockTransport, eventOf, nextValue } from "./test/utils.js";

describe("ProtocolClient", () => {
  it("opens a session and routes subscribed events by channel and namespace", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subscription = await session.subscribe({
      channels: ["messages"],
      namespaces: [["agent_1"]],
    });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", message_id: "msg_1" },
        { namespace: ["agent_1"], node: "planner", seq: 1, eventId: "evt_1" }
      )
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
    const session = await client.open({ protocol_version: "0.3.0" });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", message_id: "msg_early" },
        { namespace: ["agent_2"], node: "writer", seq: 2, eventId: "evt_early" }
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const subscription = await session.subscribe({
      channels: ["messages"],
      namespaces: [["agent_2"]],
    });

    const replayed = await nextValue(subscription);
    expect(replayed.event_id).toBe("evt_early");
  });

  it("assembles complete messages from lifecycle events", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const messages = await session.subscribe("messages", { namespaces: [[]] });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", message_id: "msg_final" },
        { namespace: [], node: "agent", seq: 3, eventId: "evt_3" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "content-block-start", index: 0, content_block: { type: "text", text: "" } },
        { namespace: [], node: "agent", seq: 4, eventId: "evt_4" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content_block: { type: "text", text: "Hello " } },
        { namespace: [], node: "agent", seq: 5, eventId: "evt_5" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content_block: { type: "text", text: "world" } },
        { namespace: [], node: "agent", seq: 6, eventId: "evt_6" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "content-block-finish", index: 0, content_block: { type: "text", text: "Hello world" } },
        { namespace: [], node: "agent", seq: 7, eventId: "evt_7" }
      )
    );
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-finish", reason: "stop", usage: { total_tokens: 4 } },
        { namespace: [], node: "agent", seq: 8, eventId: "evt_8" }
      )
    );

    const msg = await nextValue(messages);
    const fullText = await msg.text;
    expect(fullText).toBe("Hello world");
    expect((await msg.usage)?.total_tokens).toBe(4);
  });

  it("forwards object-shaped helper params to protocol commands", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "run", commands: ["input"] },
          { name: "agent", commands: ["getTree"] },
          { name: "resource", commands: ["list", "read", "write", "download"], channels: ["resource"] },
          { name: "input", commands: ["respond", "inject"], channels: ["input"] },
          { name: "state", commands: ["get", "listCheckpoints", "fork"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    await session.resource!.list({ namespace: ["agent_1"], path: "/workspace/src" });
    await session.input!.inject({
      namespace: ["agent_1"],
      message: { role: "user", content: "Also check the error handling" },
    });
    await session.input!.respond({
      namespace: ["agent_1"],
      interrupt_id: "interrupt_1",
      response: { approved: true },
    });
    await session.state!.fork({
      checkpoint_id: "checkpoint_abc",
      input: { messages: [{ role: "user", content: "Retry" }] },
    });

    expect(
      transport.sentCommands.slice(-4).map((c) => c.method)
    ).toEqual(["resource.list", "input.inject", "input.respond", "state.fork"]);
  });

  it("tracks applied_through_seq on command responses", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const result = await session.run.input({
      input: { messages: [{ role: "user", content: "hi" }] },
    });

    expect(result.run_id).toBe("run_1");
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
    const session = await client.open({ protocol_version: "0.3.0" });

    await expect(
      session.subscribe({ channels: ["messages"] as Channel[] })
    ).rejects.toThrow(/not advertised/);
  });

  it("skips capability enforcement when modules is empty", async () => {
    const transport = new MockTransport({
      capabilities: { modules: [], payload_types: [], content_block_types: [] },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    expect(session.hasModule("run")).toBe(true);
    expect(session.hasModule("anything")).toBe(true);
    expect(session.supportsChannel("messages")).toBe(true);
    expect(session.supportsCommand("run.input")).toBe(true);

    expect(session.input).toBeDefined();
    expect(session.state).toBeDefined();
    expect(session.resource).toBeDefined();
    expect(session.sandbox).toBeDefined();
    expect(session.usage).toBeDefined();

    const result = await session.run.input({
      input: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(result.run_id).toBe("run_1");

    const sub = await session.subscribe({ channels: ["messages"] });
    transport.pushEvent(
      eventOf("messages", { event: "message-start", message_id: "m1" }, { namespace: [], seq: 1 })
    );
    const received = await nextValue(sub);
    expect(received.method).toBe("messages");
  });

  it("closes session and transport cleanly", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    await session.close();
    expect(transport.closed).toBe(true);
    expect(transport.sentCommands.filter((c) => c.method === "session.close")).toHaveLength(1);
  });

  it("uses transport factory function when provided", async () => {
    const transport = new MockTransport();
    let factoryCallCount = 0;
    const client = new ProtocolClient(() => {
      factoryCallCount++;
      return transport;
    });

    const session = await client.open({ protocol_version: "0.3.0" });
    expect(factoryCallCount).toBe(1);
    expect(session.sessionId).toBe("sess_test");
  });

  it("unsubscribes and sends unsubscribe command", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subscription = await session.subscribe({ channels: ["messages"] });
    await subscription.unsubscribe();

    expect(
      transport.sentCommands.filter((c) => c.method === "subscription.unsubscribe")
    ).toHaveLength(1);
  });

  it("supports hasModule and supportsChannel checks", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    expect(session.hasModule("run")).toBe(true);
    expect(session.hasModule("sandbox")).toBe(false);
    expect(session.supportsChannel("messages")).toBe(true);
    expect(session.supportsChannel("custom")).toBe(false);
  });

  it("describe returns session result", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const result = await session.describe();
    expect(result.session_id).toBe("sess_test");
  });

  it("usage.setBudget sends the correct command", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    await session.usage!.setBudget({ max_cost_usd: 1.0, action: "cancel" });

    const budgetCommands = transport.sentCommands.filter((c) => c.method === "usage.setBudget");
    expect(budgetCommands).toHaveLength(1);
    expect(budgetCommands[0].params).toEqual({ max_cost_usd: 1.0, action: "cancel" });
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
      eventOf("messages", { event: "message-start", message_id: "m1" }, { namespace: [] })
    );
    handle.close();

    const received = await nextValue(handle);
    expect(received.method).toBe("messages");
  });

  it("resolves waiting iterators when closed", async () => {
    const handle = new SubscriptionHandle<Event>(
      "sub_1",
      { channels: ["messages"] },
      async () => {}
    );

    const iterPromise = handle[Symbol.asyncIterator]().next();
    handle.close();

    const result = await iterPromise;
    expect(result.done).toBe(true);
  });

  it("ignores events pushed after close", async () => {
    const handle = new SubscriptionHandle<Event>(
      "sub_1",
      { channels: ["messages"] },
      async () => {}
    );

    handle.close();
    handle.push(
      eventOf("messages", { event: "message-start", message_id: "m2" }, { namespace: [] })
    );

    const result = await handle[Symbol.asyncIterator]().next();
    expect(result.done).toBe(true);
  });
});

describe("custom:name subscriptions", () => {
  it("subscribes to custom:a2a without capability assertion", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const sub = await session.subscribe("custom:a2a");
    expect(sub.subscriptionId).toMatch(/^sub_/);
  });

  it("unwraps named custom events to raw payload", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const sub = await session.subscribe("custom:a2a");
    const payload = { kind: "status-update", status: "working" };
    transport.pushEvent(
      eventOf("custom", { name: "a2a", payload })
    );

    const received = await nextValue(sub);
    expect(received).toEqual(payload);
  });

  it("delivers full events for plain 'custom' subscriptions", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "custom", channels: ["custom"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const sub = await session.subscribe("custom");
    const payload = { kind: "status-update", status: "working" };
    transport.pushEvent(
      eventOf("custom", { name: "a2a", payload })
    );

    const received = await nextValue(sub);
    expect(received.method).toBe("custom");
    expect((received.params.data as { name: string }).name).toBe("a2a");
  });
});

describe("ProtocolError", () => {
  it("wraps error response with code and message", () => {
    const error = new ProtocolError({
      type: "error",
      id: 1,
      error: "invalid_argument",
      message: "Missing required field",
    });

    expect(error.name).toBe("ProtocolError");
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toBe("Missing required field");
    expect(error.response.type).toBe("error");
  });
});

describe("ToolCallAssembler", () => {
  it("assembles tool-started into AssembledToolCall with promise lifecycle", async () => {
    const assembler = new ToolCallAssembler();
    const startEvent = eventOf("tools", {
      event: "tool-started",
      tool_call_id: "tc_1",
      tool_name: "search",
      input: { query: "weather" },
    }, { namespace: ["agent"] });

    const tc = assembler.consume(startEvent as import("@langchain/protocol").ToolsEvent);
    expect(tc).toBeDefined();
    expect(tc!.name).toBe("search");
    expect(tc!.callId).toBe("tc_1");
    expect(tc!.input).toEqual({ query: "weather" });
    expect(tc!.namespace).toEqual(["agent"]);

    const finishEvent = eventOf("tools", {
      event: "tool-finished",
      tool_call_id: "tc_1",
      output: { content: "Sunny in Paris" },
    }, { namespace: ["agent"] });

    assembler.consume(finishEvent as import("@langchain/protocol").ToolsEvent);

    await expect(tc!.output).resolves.toEqual({ content: "Sunny in Paris" });
    await expect(tc!.status).resolves.toBe("finished");
    await expect(tc!.error).resolves.toBeUndefined();
  });

  it("resolves error status on tool-error", async () => {
    const assembler = new ToolCallAssembler();
    const tc = assembler.consume(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "tc_err",
      tool_name: "fail_tool",
      input: {},
    }) as import("@langchain/protocol").ToolsEvent);

    assembler.consume(eventOf("tools", {
      event: "tool-error",
      tool_call_id: "tc_err",
      message: "Connection timeout",
    }) as import("@langchain/protocol").ToolsEvent);

    await expect(tc!.status).resolves.toBe("error");
    await expect(tc!.error).resolves.toBe("Connection timeout");
    await expect(tc!.output).rejects.toThrow("Connection timeout");
  });

  it("ignores tool-output-delta events (returns undefined)", () => {
    const assembler = new ToolCallAssembler();
    assembler.consume(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "tc_d",
      tool_name: "stream_tool",
      input: {},
    }) as import("@langchain/protocol").ToolsEvent);

    const result = assembler.consume(eventOf("tools", {
      event: "tool-output-delta",
      tool_call_id: "tc_d",
      delta: "partial",
    }) as import("@langchain/protocol").ToolsEvent);

    expect(result).toBeUndefined();
  });
});

describe("subscribe(\"toolCalls\")", () => {
  it("yields assembled tool calls through the subscription", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const tools = await session.subscribe("toolCalls");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "tc_sub_1",
      tool_name: "calculator",
      input: { a: 3, b: 4 },
    }, { namespace: [], seq: 1 }));

    transport.pushEvent(eventOf("tools", {
      event: "tool-finished",
      tool_call_id: "tc_sub_1",
      output: { result: 7 },
    }, { namespace: [], seq: 2 }));

    const tc = await nextValue(tools);
    expect(tc.name).toBe("calculator");
    expect(tc.callId).toBe("tc_sub_1");
    expect(tc.input).toEqual({ a: 3, b: 4 });
    await expect(tc.output).resolves.toEqual({ result: 7 });
    await expect(tc.status).resolves.toBe("finished");
  });
});

describe("subscribe(\"values\")", () => {
  it("raw subscribe via params form delivers events", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "values", channels: ["values"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const rawSub = await session.subscribe({ channels: ["values"] });

    transport.pushEvent(eventOf("values", {
      messages: [{ role: "user", content: "hi" }],
    }, { namespace: [], seq: 1 }));

    const event = await nextValue(rawSub);
    expect(event.method).toBe("values");
  });

  it("extracts state data from values events", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "values", channels: ["values"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });
    const values = await session.subscribe("values");

    transport.pushEvent(eventOf("values", {
      messages: [{ role: "user", content: "hi" }],
      count: 1,
    }, { namespace: [], seq: 1 }));

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({
      messages: [{ role: "user", content: "hi" }],
      count: 1,
    });
  });

  it("resolves output promise with final value on close", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "values", channels: ["values"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });
    const values = await session.subscribe("values");

    transport.pushEvent(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));
    transport.pushEvent(eventOf("values", { step: 2 }, { namespace: [], seq: 2 }));

    await new Promise((r) => setTimeout(r, 10));
    await transport.close();

    const final = await values.output;
    expect(final).toEqual({ step: 2 });
  });
});

describe("subscribe(\"subgraphs\")", () => {
  it("discovers subgraphs from lifecycle started events", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subgraphs = await session.subscribe("subgraphs");

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "researcher",
      trigger_call_id: "call_abc",
    }, { namespace: ["researcher:0"], seq: 1 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "coder",
    }, { namespace: ["coder:1"], seq: 2 }));

    const first = await nextValue(subgraphs);
    expect(first.name).toBe("researcher");
    expect(first.index).toBe(0);
    expect(first.namespace).toEqual(["researcher:0"]);
    expect(first.triggerCallId).toBe("call_abc");
    expect(first.graphName).toBe("researcher");

    const second = await nextValue(subgraphs);
    expect(second.name).toBe("coder");
    expect(second.index).toBe(1);
    expect(second.namespace).toEqual(["coder:1"]);
    expect(second.triggerCallId).toBeUndefined();
    expect(second.graphName).toBe("coder");
  });

  it("ignores non-started lifecycle events", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subgraphs = await session.subscribe("subgraphs");

    transport.pushEvent(eventOf("lifecycle", {
      event: "running",
      graph_name: "agent",
    }, { namespace: ["agent:0"], seq: 1 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "actual_sub",
    }, { namespace: ["actual_sub:0"], seq: 2 }));

    const first = await nextValue(subgraphs);
    expect(first.name).toBe("actual_sub");
  });

  it("deduplicates same namespace", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subgraphs = await session.subscribe("subgraphs");

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "worker",
    }, { namespace: ["worker:0"], seq: 1 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "worker",
    }, { namespace: ["worker:0"], seq: 2 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "other",
    }, { namespace: ["other:0"], seq: 3 }));

    const first = await nextValue(subgraphs);
    expect(first.name).toBe("worker");

    const second = await nextValue(subgraphs);
    expect(second.name).toBe("other");
  });

  it("SubgraphHandle.subscribe() scopes to the subgraph namespace", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
          { name: "values", channels: ["values"] },
          { name: "tools", channels: ["tools"] },
          { name: "messages", channels: ["messages"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subgraphs = await session.subscribe("subgraphs");

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "researcher",
    }, { namespace: ["researcher:0"], seq: 1 }));

    const sub = await nextValue(subgraphs);
    expect(sub.name).toBe("researcher");

    const values = await sub.subscribe("values");
    transport.pushEvent(eventOf("values", {
      messages: ["from researcher"],
    }, { namespace: ["researcher:0"], seq: 2 }));

    transport.pushEvent(eventOf("values", {
      messages: ["from root"],
    }, { namespace: [], seq: 3 }));

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({ messages: ["from researcher"] });

    const subscribeCommands = transport.sentCommands.filter(
      (c) => c.method === "subscription.subscribe"
    );
    const lastSubscribe = subscribeCommands[subscribeCommands.length - 1];
    expect(lastSubscribe.params).toHaveProperty("namespaces");
    expect((lastSubscribe.params as { namespaces: string[][] }).namespaces).toEqual([
      ["researcher:0"],
    ]);
  });

  it("SubgraphHandle.subscribe(\"toolCalls\") returns ToolSubscriptionHandle", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
          { name: "tools", channels: ["tools"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subgraphs = await session.subscribe("subgraphs");

    transport.pushEvent(eventOf("lifecycle", {
      event: "started",
      graph_name: "worker",
    }, { namespace: ["worker:0"], seq: 1 }));

    const sub = await nextValue(subgraphs);
    const tools = await sub.subscribe("toolCalls");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "tc_sub",
      tool_name: "search",
      input: { q: "test" },
    }, { namespace: ["worker:0"], seq: 2 }));

    transport.pushEvent(eventOf("tools", {
      event: "tool-finished",
      tool_call_id: "tc_sub",
      output: { result: "found" },
    }, { namespace: ["worker:0"], seq: 3 }));

    const tc = await nextValue(tools);
    expect(tc.name).toBe("search");
    expect(tc.callId).toBe("tc_sub");
    await expect(tc.output).resolves.toEqual({ result: "found" });
  });
});

describe("subscribe(\"messages\")", () => {
  it("yields StreamingMessage with text deltas and final text", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const messages = await session.subscribe("messages");

    transport.pushEvent(eventOf("messages", {
      event: "message-start",
      message_id: "msg_1",
    }, { namespace: [], node: "agent", seq: 1 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-start",
      index: 0,
      content_block: { type: "text", text: "" },
    }, { namespace: [], node: "agent", seq: 2 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-delta",
      index: 0,
      content_block: { type: "text", text: "Hello " },
    }, { namespace: [], node: "agent", seq: 3 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-delta",
      index: 0,
      content_block: { type: "text", text: "world" },
    }, { namespace: [], node: "agent", seq: 4 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-finish",
      index: 0,
      content_block: { type: "text", text: "Hello world" },
    }, { namespace: [], node: "agent", seq: 5 }));

    transport.pushEvent(eventOf("messages", {
      event: "message-finish",
      reason: "stop",
      usage: { total_tokens: 10 },
    }, { namespace: [], node: "agent", seq: 6 }));

    const msg = await nextValue(messages);
    expect(msg.node).toBe("agent");
    expect(msg.messageId).toBe("msg_1");

    const fullText = await msg.text;
    expect(fullText).toBe("Hello world");

    const usage = await msg.usage;
    expect(usage?.total_tokens).toBe(10);
  });

  it("streams reasoning deltas", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const messages = await session.subscribe("messages");

    transport.pushEvent(eventOf("messages", {
      event: "message-start",
      message_id: "msg_r",
    }, { namespace: [], node: "agent", seq: 1 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-start",
      index: 0,
      content_block: { type: "reasoning", reasoning: "" },
    }, { namespace: [], node: "agent", seq: 2 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-delta",
      index: 0,
      content_block: { type: "reasoning", reasoning: "Let me think..." },
    }, { namespace: [], node: "agent", seq: 3 }));

    transport.pushEvent(eventOf("messages", {
      event: "content-block-finish",
      index: 0,
      content_block: { type: "reasoning", reasoning: "Let me think..." },
    }, { namespace: [], node: "agent", seq: 4 }));

    transport.pushEvent(eventOf("messages", {
      event: "message-finish",
      reason: "stop",
    }, { namespace: [], node: "agent", seq: 5 }));

    const msg = await nextValue(messages);
    const fullReasoning = await msg.reasoning;
    expect(fullReasoning).toBe("Let me think...");
  });
});

describe("subscribe(\"subagents\")", () => {
  it("discovers subagents from task tool-started events", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subagents = await session.subscribe("subagents");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_1",
      tool_name: "task",
      input: { description: "Research AI trends", subagent_type: "researcher" },
    } as Event["params"]["data"], { namespace: [], seq: 1 }));

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_2",
      tool_name: "task",
      input: { description: "Write code", subagent_type: "coder" },
    } as Event["params"]["data"], { namespace: [], seq: 2 }));

    const first = await nextValue(subagents);
    expect(first.name).toBe("researcher");
    expect(first.callId).toBe("task_1");
    await expect(first.taskInput).resolves.toBe("Research AI trends");

    const second = await nextValue(subagents);
    expect(second.name).toBe("coder");
    expect(second.callId).toBe("task_2");
    await expect(second.taskInput).resolves.toBe("Write code");
  });

  it("resolves output on tool-finished", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subagents = await session.subscribe("subagents");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_r",
      tool_name: "task",
      input: { description: "Research", subagent_type: "researcher" },
    } as Event["params"]["data"], { namespace: [], seq: 1 }));

    const sub = await nextValue(subagents);

    transport.pushEvent(eventOf("tools", {
      event: "tool-finished",
      tool_call_id: "task_r",
      output: { result: "AI is growing fast" },
    } as Event["params"]["data"], { namespace: [], seq: 2 }));

    await expect(sub.output).resolves.toEqual({ result: "AI is growing fast" });
  });

  it("rejects output on tool-error", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subagents = await session.subscribe("subagents");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_e",
      tool_name: "task",
      input: { description: "Fail", subagent_type: "broken" },
    } as Event["params"]["data"], { namespace: [], seq: 1 }));

    const sub = await nextValue(subagents);

    transport.pushEvent(eventOf("tools", {
      event: "tool-error",
      tool_call_id: "task_e",
      message: "Subagent crashed",
    } as Event["params"]["data"], { namespace: [], seq: 2 }));

    await expect(sub.output).rejects.toThrow("Subagent crashed");
  });

  it("ignores non-task tool events", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subagents = await session.subscribe("subagents");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "regular_1",
      tool_name: "search",
      input: { query: "test" },
    } as Event["params"]["data"], { namespace: [], seq: 1 }));

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_1",
      tool_name: "task",
      input: { description: "Do work", subagent_type: "worker" },
    } as Event["params"]["data"], { namespace: [], seq: 2 }));

    const first = await nextValue(subagents);
    expect(first.name).toBe("worker");
  });

  it("SubagentHandle.subscribe() scopes to subagent namespace", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "tools", channels: ["tools"] },
          { name: "values", channels: ["values"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subagents = await session.subscribe("subagents");

    transport.pushEvent(eventOf("tools", {
      event: "tool-started",
      tool_call_id: "task_w",
      tool_name: "task",
      input: { description: "Work", subagent_type: "worker" },
    } as Event["params"]["data"], { namespace: ["tools:task_w"], seq: 1 }));

    const sub = await nextValue(subagents);
    expect(sub.namespace).toEqual(["tools:task_w"]);

    const values = await sub.subscribe("values");
    transport.pushEvent(eventOf("values", {
      step: 1,
    } as Event["params"]["data"], { namespace: ["tools:task_w"], seq: 2 }));

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({ step: 1 });

    const subscribeCommands = transport.sentCommands.filter(
      (c) => c.method === "subscription.subscribe"
    );
    const lastSubscribe = subscribeCommands[subscribeCommands.length - 1];
    expect((lastSubscribe.params as { namespaces: string[][] }).namespaces).toEqual([
      ["tools:task_w"],
    ]);
  });
});

describe("interrupts", () => {
  it("tracks interrupted state from lifecycle events", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
          { name: "input", commands: ["respond", "inject"], channels: ["input"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    expect(session.interrupted).toBe(false);
    expect(session.interrupts).toEqual([]);

    transport.pushEvent(eventOf("input.requested", {
      interrupt_id: "int_1",
      payload: { question: "Approve?" },
    }, { namespace: ["agent"], seq: 1 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "interrupted",
    }, { namespace: ["agent"], seq: 2 }));

    await new Promise((r) => setTimeout(r, 10));

    expect(session.interrupted).toBe(true);
    expect(session.interrupts).toHaveLength(1);
    expect(session.interrupts[0].interruptId).toBe("int_1");
    expect(session.interrupts[0].payload).toEqual({
      question: "Approve?",
    });
    expect(session.interrupts[0].namespace).toEqual(["agent"]);
  });

  it("handles multiple interrupt payloads", async () => {
    const transport = new MockTransport({
      capabilities: {
        modules: [
          { name: "session", commands: ["open", "describe", "close"] },
          { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
          { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
          { name: "input", commands: ["respond", "inject"], channels: ["input"] },
        ],
      },
    });
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    transport.pushEvent(eventOf("input.requested", {
      interrupt_id: "int_a",
      payload: { question: "First?" },
    }, { namespace: [], seq: 1 }));

    transport.pushEvent(eventOf("input.requested", {
      interrupt_id: "int_b",
      payload: { question: "Second?" },
    }, { namespace: [], seq: 2 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "interrupted",
    }, { namespace: [], seq: 3 }));

    await new Promise((r) => setTimeout(r, 10));

    expect(session.interrupts).toHaveLength(2);
    expect(session.interrupts[0].interruptId).toBe("int_a");
    expect(session.interrupts[1].interruptId).toBe("int_b");
  });
});
