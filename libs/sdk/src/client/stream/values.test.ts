import type { Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import { ProtocolClient, SubscriptionHandle } from "./index.js";
import { ValuesSubscriptionHandle } from "./handles/values.js";
import { MockTransport, eventOf, nextValue } from "./test/utils.js";

function makeSource(): SubscriptionHandle<Event> {
  return new SubscriptionHandle<Event>(
    "sub_test",
    { channels: ["values"] },
    async () => {}
  );
}

function fullCapabilities() {
  return {
    capabilities: {
      modules: [
        { name: "session", commands: ["open", "describe", "close"] },
        { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
        { name: "run", commands: ["input"] },
        { name: "agent", commands: ["getTree"], channels: ["lifecycle"] },
        { name: "input", commands: ["respond", "inject"], channels: ["input"] },
        { name: "values", channels: ["values"] },
      ],
    },
  };
}

describe("ValuesSubscriptionHandle (unit)", () => {
  it("yields extracted data from values events", async () => {
    const source = makeSource();
    const values = new ValuesSubscriptionHandle(source);

    const iter = values[Symbol.asyncIterator]();

    source.push(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ step: 1 });
  });

  it("resolves output promise with last value on close", async () => {
    const source = makeSource();
    const values = new ValuesSubscriptionHandle(source);

    const iter = values[Symbol.asyncIterator]();

    source.push(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));
    source.push(eventOf("values", { step: 2 }, { namespace: [], seq: 2 }));

    await iter.next();
    await iter.next();

    source.close();

    const final = await values.output;
    expect(final).toEqual({ step: 2 });
  });

  it("works when wrapping a session-created subscription", async () => {
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
    const values = new ValuesSubscriptionHandle(rawSub);

    transport.pushEvent(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({ step: 1 });
  });

  it("works via session.subscribe(\"values\")", async () => {
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

    const snapshot = await nextValue(values);
    expect(snapshot).toEqual({ step: 1 });
  });

  it("pauses iterator on terminal lifecycle and resumes for next run", async () => {
    const transport = new MockTransport(fullCapabilities());
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });
    const values = await session.subscribe("values");

    transport.pushEvent(eventOf("values", { messages: ["a"] }, { namespace: [], seq: 1 }));
    transport.pushEvent(eventOf("values", { messages: ["a", "b"] }, { namespace: [], seq: 2 }));
    transport.pushEvent(eventOf("lifecycle", {
      event: "interrupted",
    }, { namespace: [], seq: 3 }));

    const run1: unknown[] = [];
    for await (const snapshot of values) {
      run1.push(snapshot);
    }

    expect(run1).toEqual([
      { messages: ["a"] },
      { messages: ["a", "b"] },
    ]);
    expect(session.interrupted).toBe(true);
    expect(session.interrupts).toHaveLength(0);

    const run1Output = await values.output;
    expect(run1Output).toEqual({ messages: ["a", "b"] });

    await session.input!.respond({
      interrupt_id: "int_1",
      response: { decisions: [{ action: "tool", type: "approve" }] },
    });

    expect(session.interrupted).toBe(false);
    expect(session.interrupts).toHaveLength(0);

    transport.pushEvent(eventOf("values", { messages: ["a", "b", "c"] }, { namespace: [], seq: 4 }));
    transport.pushEvent(eventOf("lifecycle", {
      event: "completed",
      graph_name: "root",
    }, { namespace: [], seq: 5 }));

    const run2: unknown[] = [];
    for await (const snapshot of values) {
      run2.push(snapshot);
    }

    expect(run2).toEqual([{ messages: ["a", "b", "c"] }]);

    const run2Output = await values.output;
    expect(run2Output).toEqual({ messages: ["a", "b", "c"] });
  });

  it("terminates iterator when root lifecycle completed event arrives", async () => {
    const transport = new MockTransport(fullCapabilities());
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });
    const values = await session.subscribe("values");

    transport.pushEvent(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));
    transport.pushEvent(eventOf("values", { step: 2 }, { namespace: [], seq: 2 }));
    transport.pushEvent(eventOf("lifecycle", {
      event: "completed",
      graph_name: "root",
    }, { namespace: [], seq: 3 }));

    const collected: unknown[] = [];
    for await (const snapshot of values) {
      collected.push(snapshot);
    }

    expect(collected).toEqual([{ step: 1 }, { step: 2 }]);
    expect(session.interrupted).toBe(false);

    const output = await values.output;
    expect(output).toEqual({ step: 2 });
  });

  it("does not terminate iterator for subgraph lifecycle completed events", async () => {
    const transport = new MockTransport(fullCapabilities());
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });
    const values = await session.subscribe("values");

    transport.pushEvent(eventOf("values", { step: 1 }, { namespace: [], seq: 1 }));
    transport.pushEvent(eventOf("lifecycle", {
      event: "completed",
      graph_name: "sub",
    }, { namespace: ["sub"], seq: 2 }));
    transport.pushEvent(eventOf("values", { step: 2 }, { namespace: [], seq: 3 }));
    transport.pushEvent(eventOf("lifecycle", {
      event: "completed",
      graph_name: "root",
    }, { namespace: [], seq: 4 }));

    const collected: unknown[] = [];
    for await (const snapshot of values) {
      collected.push(snapshot);
    }

    expect(collected).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it("run.input resets interrupted state", async () => {
    const transport = new MockTransport(fullCapabilities());
    const client = new ProtocolClient(transport);
    const session = await client.open({ protocol_version: "0.3.0" });

    transport.pushEvent(eventOf("input.requested", {
      interrupt_id: "int_1",
      payload: { question: "Approve?" },
    }, { namespace: [], seq: 1 }));

    transport.pushEvent(eventOf("lifecycle", {
      event: "interrupted",
    }, { namespace: [], seq: 2 }));

    await new Promise((r) => setTimeout(r, 10));

    expect(session.interrupted).toBe(true);
    expect(session.interrupts).toHaveLength(1);

    await session.run.input({ input: { messages: [] } });

    expect(session.interrupted).toBe(false);
    expect(session.interrupts).toHaveLength(0);
  });
});
