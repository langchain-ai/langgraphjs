import { describe, expect, it } from "vitest";
import { convertToProtocolEvent } from "./convert.js";

describe("convertToProtocolEvent", () => {
  const ns = ["agent", "inner"];

  it("converts 'messages' mode events", () => {
    const payload = { event: "message-start", role: "assistant" };
    const result = convertToProtocolEvent(ns, "messages", payload, 1);
    expect(result).toMatchObject({
      type: "event",
      seq: 1,
      method: "messages",
      params: { namespace: ns, data: payload },
    });
    expect(result!.params.timestamp).toBeTypeOf("number");
  });

  it("converts 'values' mode events", () => {
    const payload = { count: 42 };
    const result = convertToProtocolEvent(ns, "values", payload, 2);
    expect(result).toMatchObject({
      type: "event",
      seq: 2,
      method: "values",
      params: { namespace: ns, data: payload },
    });
  });

  it("converts 'updates' mode — extracts node from {nodeName: delta} shape", () => {
    const result = convertToProtocolEvent(
      ns,
      "updates",
      { myNode: { foo: "bar" } },
      3
    );
    expect(result).toMatchObject({
      method: "updates",
      params: {
        data: { node: "myNode", values: { foo: "bar" } },
      },
    });
  });

  it("converts 'tools' mode — on_tool_start → tool-started", () => {
    const payload = {
      event: "on_tool_start",
      name: "search",
      toolCallId: "tc_1",
      input: { q: "hello" },
    };
    const result = convertToProtocolEvent(ns, "tools", payload, 4);
    expect(result!.params.data).toEqual({
      event: "tool-started",
      toolName: "search",
      toolCallId: "tc_1",
      input: { q: "hello" },
    });
  });

  it("converts 'tools' mode — on_tool_end → tool-finished", () => {
    const payload = {
      event: "on_tool_end",
      output: "result",
      toolCallId: "tc_2",
    };
    const result = convertToProtocolEvent(ns, "tools", payload, 5);
    expect(result!.params.data).toEqual({
      event: "tool-finished",
      output: "result",
      toolCallId: "tc_2",
    });
  });

  it("converts 'tools' mode — on_tool_error → tool-error with Error-like objects and plain strings", () => {
    const withError = convertToProtocolEvent(
      ns,
      "tools",
      { event: "on_tool_error", error: new Error("boom") },
      6
    );
    expect(withError!.params.data).toMatchObject({
      event: "tool-error",
      message: "boom",
    });

    const withString = convertToProtocolEvent(
      ns,
      "tools",
      { event: "on_tool_error", error: "plain failure" },
      7
    );
    expect(withString!.params.data).toMatchObject({
      event: "tool-error",
      message: "plain failure",
    });
  });

  it("converts 'tools' mode — on_tool_event → tool-output-delta", () => {
    const result = convertToProtocolEvent(
      ns,
      "tools",
      { event: "on_tool_event", data: "chunk", toolCallId: "tc_3" },
      8
    );
    expect(result!.params.data).toEqual({
      event: "tool-output-delta",
      delta: "chunk",
      toolCallId: "tc_3",
    });
  });

  it("converts 'custom' mode events", () => {
    const payload = { key: "value" };
    const result = convertToProtocolEvent(ns, "custom", payload, 9);
    expect(result).toMatchObject({
      method: "custom",
      params: { data: { payload } },
    });
  });

  it("converts 'debug', 'checkpoints', 'tasks' mode events", () => {
    for (const mode of ["debug", "checkpoints", "tasks"] as const) {
      const payload = { info: mode };
      const result = convertToProtocolEvent(ns, mode, payload, 10);
      expect(result).toMatchObject({
        method: mode,
        params: { namespace: ns, data: payload },
      });
    }
  });

  it("returns null for unknown modes", () => {
    const result = convertToProtocolEvent(
      ns,
      "nonexistent" as never,
      {},
      11
    );
    expect(result).toBeNull();
  });

  it("preserves namespace in params", () => {
    const deep = ["root", "sub", "leaf"];
    const result = convertToProtocolEvent(deep, "values", {}, 12);
    expect(result!.params.namespace).toEqual(deep);
  });

  it("assigns correct seq numbers", () => {
    const r1 = convertToProtocolEvent(ns, "values", {}, 100);
    const r2 = convertToProtocolEvent(ns, "values", {}, 200);
    expect(r1!.seq).toBe(100);
    expect(r2!.seq).toBe(200);
  });

  it("updates payload with empty object when non-object", () => {
    const result = convertToProtocolEvent(ns, "updates", null, 13);
    expect(result!.params.data).toEqual({ values: {} });

    const result2 = convertToProtocolEvent(ns, "updates", 42, 14);
    expect(result2!.params.data).toEqual({ values: {} });
  });

  it("toolCallId is preserved when present, defaults to empty string when absent", () => {
    const withId = convertToProtocolEvent(
      ns,
      "tools",
      { event: "on_tool_start", name: "t", toolCallId: "id_1" },
      15
    );
    expect(withId!.params.data).toHaveProperty("toolCallId", "id_1");

    const withoutId = convertToProtocolEvent(
      ns,
      "tools",
      { event: "on_tool_start", name: "t" },
      16
    );
    expect(withoutId!.params.data).toHaveProperty("toolCallId", "");
  });
});
