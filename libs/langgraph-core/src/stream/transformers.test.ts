import { describe, expect, it } from "vitest";
import {
  createMessagesTransformer,
  createValuesTransformer,
} from "./transformers/index.js";
import {
  collectAsyncIterable as collect,
  makeProtocolEvent,
} from "./test-utils.js";
import type { ProtocolEvent } from "./types.js";

function makeEvent(
  method: string,
  data: unknown,
  namespace: string[] = [],
  node?: string,
  seq = 0
): ProtocolEvent {
  return makeProtocolEvent(method, { namespace, data, node, seq });
}

/**
 * Root-level transformer tests use path=[] and emit events at namespace
 * ["agent"] (depth 1), because the MessagesTransformer only captures events
 * at exactly path.length + 1 — the graph's own node namespace depth.
 */
describe("createMessagesTransformer", () => {
  const agentNs = ["agent"];

  it("creates ChatModelStreams from message-start events", () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, agentNs)
    );
    transformer.finalize?.();

    const collected = collect(proj.messages);
    return expect(collected).resolves.toHaveLength(1);
  });

  it("forwards content-block-delta to active stream", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );
    transformer.process(
      makeEvent("messages", {
        event: "content-block-delta",
        index: 0,
        content: { type: "text", text: "hello" },
      }, agentNs)
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, agentNs)
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);

    const text = await streams[0].text;
    expect(text).toBe("hello");
  });

  it("routes interleaved message streams by run id", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();

    transformer.process(
      makeEvent(
        "messages",
        { event: "message-start", id: "msg-a", run_id: "run-a" },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-start", id: "msg-b", run_id: "run-b" },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "text", text: "" },
          run_id: "run-b",
        },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: "B" },
          run_id: "run-b",
        },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "text", text: "" },
          run_id: "run-a",
        },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: "A" },
          run_id: "run-a",
        },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-finish", run_id: "run-b" },
        agentNs
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-finish", run_id: "run-a" },
        agentNs
      )
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(2);
    await expect(streams[0].text).resolves.toBe("A");
    await expect(streams[1].text).resolves.toBe("B");
  });

  it("closes stream on message-finish", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, agentNs)
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);

    const events = await collect(streams[0]);
    const finishEvents = events.filter((e) => e.event === "message-finish");
    expect(finishEvents).toHaveLength(1);
  });

  it("nodeFilter only processes events from matching node", async () => {
    const transformer = createMessagesTransformer([], "agent");
    const proj = transformer.init();

    transformer.process(
      makeEvent(
        "messages",
        { event: "message-start", role: "ai" },
        ["other_node"],
        "other"
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-finish", reason: "stop" },
        ["other_node"],
        "other"
      )
    );

    transformer.process(
      makeEvent(
        "messages",
        { event: "message-start", role: "ai" },
        agentNs,
        "agent"
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-finish", reason: "stop" },
        agentNs,
        "agent"
      )
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);
    expect(streams[0].node).toBe("agent");
  });

  it("captures events only at depth + 1 (direct child nodes)", async () => {
    const transformer = createMessagesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, [
        "root",
        "node",
      ])
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, [
        "root",
        "node",
      ])
    );

    transformer.process(
      makeEvent(
        "messages",
        { event: "message-start", role: "ai" },
        ["root"]
      )
    );
    transformer.process(
      makeEvent(
        "messages",
        { event: "message-finish", reason: "stop" },
        ["root"]
      )
    );

    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);
    expect(streams[0].namespace).toEqual(["root", "node"]);
  });

  it("ignores events from deeply nested namespaces (depth + 2 or more)", async () => {
    const transformer = createMessagesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, [
        "root",
        "sub",
        "inner",
      ])
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, [
        "root",
        "sub",
        "inner",
      ])
    );

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, [
        "root",
        "node",
      ])
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, [
        "root",
        "node",
      ])
    );

    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);
    expect(streams[0].namespace).toEqual(["root", "node"]);
  });

  it("ignores events from unrelated namespaces", async () => {
    const transformer = createMessagesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, ["other", "node"])
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, ["other", "node"])
    );

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, ["root", "node"])
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, ["root", "node"])
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(1);
    expect(streams[0].namespace).toEqual(["root", "node"]);
  });

  it("finalize closes the log", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(0);
  });

  it("fail propagates error to active stream and log", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();
    const error = new Error("boom");

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );

    const iter = proj.messages[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);

    const stream = first.value;
    // Suppress unhandled rejections on internal promises before fail() rejects them.
    stream.text.then(() => {}, () => {});
    stream.reasoning.then(() => {}, () => {});
    stream.usage.then(() => {}, () => {});

    transformer.fail?.(error);

    await expect(iter.next()).rejects.toThrow("boom");
  });

  it("multiple message lifecycles create separate ChatModelStreams", async () => {
    const transformer = createMessagesTransformer([]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );
    transformer.process(
      makeEvent("messages", {
        event: "content-block-delta",
        index: 0,
        content: { type: "text", text: "first" },
      }, agentNs)
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, agentNs)
    );

    transformer.process(
      makeEvent("messages", { event: "message-start", role: "ai" }, agentNs)
    );
    transformer.process(
      makeEvent("messages", {
        event: "content-block-delta",
        index: 0,
        content: { type: "text", text: "second" },
      }, agentNs)
    );
    transformer.process(
      makeEvent("messages", { event: "message-finish", reason: "stop" }, agentNs)
    );
    transformer.finalize?.();

    const streams = await collect(proj.messages);
    expect(streams).toHaveLength(2);

    const text0 = await streams[0].text;
    const text1 = await streams[1].text;
    expect(text0).toBe("first");
    expect(text1).toBe("second");
  });

});

describe("createValuesTransformer", () => {
  it("captures values events at the target namespace depth", async () => {
    const transformer = createValuesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("values", { count: 1 }, ["root"])
    );
    transformer.process(
      makeEvent("values", { count: 2 }, ["root"])
    );
    transformer.finalize?.();

    const items = await collect(proj._valuesLog.toAsyncIterable());
    expect(items).toEqual([{ count: 1 }, { count: 2 }]);
  });

  it("ignores events from different namespaces", async () => {
    const transformer = createValuesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("values", { x: 1 }, ["other"])
    );
    transformer.process(
      makeEvent("values", { x: 2 }, ["root", "child"])
    );
    transformer.finalize?.();

    const items = await collect(proj._valuesLog.toAsyncIterable());
    expect(items).toHaveLength(0);
  });

  it("ignores non-values events", async () => {
    const transformer = createValuesTransformer(["root"]);
    const proj = transformer.init();

    transformer.process(
      makeEvent("messages", { event: "message-start" }, ["root"])
    );
    transformer.finalize?.();

    const items = await collect(proj._valuesLog.toAsyncIterable());
    expect(items).toHaveLength(0);
  });

  it("finalize closes the log", async () => {
    const transformer = createValuesTransformer([]);
    const proj = transformer.init();
    transformer.finalize?.();

    const items = await collect(proj._valuesLog.toAsyncIterable());
    expect(items).toHaveLength(0);
  });

  it("fail propagates error", async () => {
    const transformer = createValuesTransformer([]);
    const proj = transformer.init();
    const error = new Error("fail");

    transformer.process(makeEvent("values", { a: 1 }, []));
    transformer.fail?.(error);

    await expect(
      collect(proj._valuesLog.toAsyncIterable())
    ).rejects.toThrow("fail");
  });

});
