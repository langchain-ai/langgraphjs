import type { Channel, Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import {
  ProtocolClient,
  ProtocolError,
  SubscriptionHandle,
} from "./index.js";
import { MockTransport, eventOf, nextValue } from "./test/utils.js";

describe("ProtocolClient", () => {
  it("opens a session and routes subscribed events by channel and namespace", async () => {
    const transport = new MockTransport();
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    const subscription = await session.subscribe("messages", {
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

    const messages = await session.subscribeMessages({ namespaces: [[]] });

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

    const assembled = await nextValue(messages);
    expect(assembled.finishReason).toBe("stop");
    expect(assembled.usage?.total_tokens).toBe(4);
    expect(assembled.blocks).toEqual([{ type: "text", text: "Hello world" }]);
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
          { name: "state", commands: ["get", "listCheckpoints", "fork"], channels: ["state"] },
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

    const subscription = await session.subscribe("messages");
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
