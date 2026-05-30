import { describe, expect, it } from "vitest";
import { convertToProtocolEvent } from "./convert.js";

describe("convertToProtocolEvent", () => {
  const ns = ["agent", "inner"];

  it("converts 'messages' mode events", () => {
    const payload = { event: "message-start", role: "assistant" };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "messages",
      payload,
      seq: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "event",
      seq: 1,
      method: "messages",
      params: { namespace: ns, data: payload },
    });
    expect(result[0].params.timestamp).toBeTypeOf("number");
  });

  it("unwraps messages tuples and preserves routing metadata", () => {
    const payload = [
      { event: "message-start", id: "msg-1" },
      { langgraph_node: "agent", run_id: "run-1" },
    ];
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "messages",
      payload,
      seq: 1,
    });

    expect(result[0]).toMatchObject({
      method: "messages",
      params: {
        namespace: ns,
        node: "agent",
        data: { event: "message-start", id: "msg-1", run_id: "run-1" },
      },
    });
  });

  it("converts 'values' mode events", () => {
    const payload = { count: 42 };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "values",
      payload,
      seq: 2,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "event",
      seq: 2,
      method: "values",
      params: { namespace: ns, data: payload },
    });
    expect(result[0].params).not.toHaveProperty("checkpoint");
  });

  it("converts 'updates' mode — extracts node from {nodeName: delta} shape", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "updates",
      payload: { myNode: { foo: "bar" } },
      seq: 3,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      method: "updates",
      params: {
        // The completed node is surfaced at the top level of `params`
        // so transformers (e.g. `LifecycleTransformer`) can attribute
        // the emission to the child namespace without re-parsing `data`.
        node: "myNode",
        data: { node: "myNode", values: { foo: "bar" } },
      },
    });
  });

  it("converts 'updates' mode — omits params.node when payload has no named node", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "updates",
      payload: {},
      seq: 3,
    });
    expect(result).toHaveLength(1);
    expect(result[0].params).not.toHaveProperty("node");
  });

  it("converts 'tools' mode — on_tool_start → tool-started", () => {
    const payload = {
      event: "on_tool_start",
      name: "search",
      toolCallId: "tc_1",
      input: { q: "hello" },
    };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload,
      seq: 4,
    });
    expect(result).toHaveLength(1);
    expect(result[0].params.data).toEqual({
      event: "tool-started",
      tool_name: "search",
      tool_call_id: "tc_1",
      input: { q: "hello" },
    });
  });

  it("converts 'tools' mode — on_tool_end → tool-finished", () => {
    const payload = {
      event: "on_tool_end",
      output: "result",
      toolCallId: "tc_2",
    };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload,
      seq: 5,
    });
    expect(result).toHaveLength(1);
    expect(result[0].params.data).toEqual({
      event: "tool-finished",
      output: "result",
      tool_call_id: "tc_2",
    });
  });

  it("converts 'tools' mode — on_tool_error → tool-error with Error-like objects and plain strings", () => {
    const withError = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload: { event: "on_tool_error", error: new Error("boom") },
      seq: 6,
    });
    expect(withError[0].params.data).toMatchObject({
      event: "tool-error",
      message: "boom",
    });

    const withString = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload: { event: "on_tool_error", error: "plain failure" },
      seq: 7,
    });
    expect(withString[0].params.data).toMatchObject({
      event: "tool-error",
      message: "plain failure",
    });
  });

  it("converts 'tools' mode — on_tool_event → tool-output-delta", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload: { event: "on_tool_event", data: "chunk", toolCallId: "tc_3" },
      seq: 8,
    });
    expect(result[0].params.data).toEqual({
      event: "tool-output-delta",
      delta: "chunk",
      tool_call_id: "tc_3",
    });
  });

  it("converts 'custom' mode events", () => {
    const payload = { key: "value" };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "custom",
      payload,
      seq: 9,
    });
    expect(result[0]).toMatchObject({
      method: "custom",
      params: { data: { payload } },
    });
  });

  it("converts 'tasks' mode events", () => {
    const payload = { info: "tasks" };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "tasks",
      payload,
      seq: 10,
    });
    expect(result[0]).toMatchObject({
      method: "tasks",
      params: { namespace: ns, data: payload },
    });
  });

  it("returns empty for 'debug' and 'checkpoints' modes (not part of V2)", () => {
    for (const mode of ["debug", "checkpoints"] as const) {
      const result = convertToProtocolEvent({
        namespace: ns,
        mode,
        payload: { info: mode },
        seq: 10,
      });
      expect(result).toEqual([]);
    }
  });

  it("emits a 'checkpoints' event immediately before the companion 'values' event when meta.checkpoint is present", () => {
    const payload = { count: 1 };
    const meta = {
      checkpoint: {
        id: "ckpt-2",
        parent_id: "ckpt-1",
        step: 1,
        source: "loop" as const,
      },
    };
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "values",
      payload,
      seq: 20,
      meta,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      seq: 20,
      method: "checkpoints",
      params: {
        namespace: ns,
        data: {
          id: "ckpt-2",
          parent_id: "ckpt-1",
          step: 1,
          source: "loop",
        },
      },
    });
    expect(result[1]).toMatchObject({
      seq: 21,
      method: "values",
      params: { namespace: ns, data: payload },
    });
    expect(result[1].params).not.toHaveProperty("checkpoint");
  });

  it("omits the companion checkpoints event on 'values' when meta is absent", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "values",
      payload: { count: 1 },
      seq: 21,
    });
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("values");
  });

  it("returns empty array for unknown modes", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "nonexistent" as never,
      payload: {},
      seq: 11,
    });
    expect(result).toEqual([]);
  });

  it("preserves namespace in params", () => {
    const deep = ["root", "sub", "leaf"];
    const result = convertToProtocolEvent({
      namespace: deep,
      mode: "values",
      payload: {},
      seq: 12,
    });
    expect(result[0].params.namespace).toEqual(deep);
  });

  it("assigns correct seq numbers", () => {
    const r1 = convertToProtocolEvent({
      namespace: ns,
      mode: "values",
      payload: {},
      seq: 100,
    });
    const r2 = convertToProtocolEvent({
      namespace: ns,
      mode: "values",
      payload: {},
      seq: 200,
    });
    expect(r1[0].seq).toBe(100);
    expect(r2[0].seq).toBe(200);
  });

  it("updates payload with empty object when non-object", () => {
    const result = convertToProtocolEvent({
      namespace: ns,
      mode: "updates",
      payload: null,
      seq: 13,
    });
    expect(result[0].params.data).toEqual({ values: {} });

    const result2 = convertToProtocolEvent({
      namespace: ns,
      mode: "updates",
      payload: 42,
      seq: 14,
    });
    expect(result2[0].params.data).toEqual({ values: {} });
  });

  it("toolCallId is preserved when present, defaults to empty string when absent", () => {
    const withId = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload: { event: "on_tool_start", name: "t", toolCallId: "id_1" },
      seq: 15,
    });
    expect(withId[0].params.data).toHaveProperty("tool_call_id", "id_1");

    const withoutId = convertToProtocolEvent({
      namespace: ns,
      mode: "tools",
      payload: { event: "on_tool_start", name: "t" },
      seq: 16,
    });
    expect(withoutId[0].params.data).toHaveProperty("tool_call_id", "");
  });
});
