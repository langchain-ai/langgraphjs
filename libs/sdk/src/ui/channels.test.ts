import { describe, expect, it, vi } from "vitest";
import { ChannelListeners, toChannelEvent } from "./channels.js";

describe("toChannelEvent", () => {
  // Each v1 event and the 1.x channel event it becomes.
  it.each([
    ["values", { a: 1 }, "values", [], { a: 1 }],
    ["updates|agent:x", { node: {} }, "updates", ["agent:x"], { node: {} }],
    ["messages|tools:a", [{ id: "m" }, {}], "messages", ["tools:a"], [{ id: "m" }, {}]],
    ["custom", { kind: "stats" }, "custom", [], { payload: { kind: "stats" } }],
    [
      "tools",
      { event: "on_tool_start", toolCallId: "c1", name: "search", input: { q: 1 } },
      "tools",
      [],
      { event: "tool-started", tool_call_id: "c1", tool_name: "search", input: { q: 1 } },
    ],
    [
      "tools",
      { event: "on_tool_end", toolCallId: "c1", name: "search", output: "ok" },
      "tools",
      [],
      { event: "tool-finished", tool_call_id: "c1", output: "ok" },
    ],
    [
      "tools",
      { event: "on_tool_error", toolCallId: "c1", name: "search", error: { error: "Error", message: "boom" } },
      "tools",
      [],
      { event: "tool-error", tool_call_id: "c1", message: "boom" },
    ],
    [
      "tools",
      { event: "on_tool_event", toolCallId: "c1", name: "search", data: { step: 1 } },
      "tools",
      [],
      { event: "tool-progress", tool_call_id: "c1", data: { step: 1 } },
    ],
    [
      "lifecycle|tools:a",
      { event: "started", namespace: ["tools:a"], tool_call_id: "c1" },
      "lifecycle",
      ["tools:a"],
      { event: "started", cause: { type: "toolCall", tool_call_id: "c1" } },
    ],
    [
      "lifecycle|tools:a",
      { event: "failed", namespace: ["tools:a"], error: { error: "Error", message: "boom" } },
      "lifecycle",
      ["tools:a"],
      { event: "failed", error: "boom" },
    ],
    ["end", { status: "success" }, "lifecycle", [], { event: "completed" }],
    ["end", { status: "timeout" }, "lifecycle", [], { event: "failed" }],
    ["end", { status: "interrupted" }, "lifecycle", [], { event: "interrupted" }],
  ])("%s %j is a %s event", (event, data, method, namespace, channelData) => {
    expect(toChannelEvent(event, data)).toEqual({
      method,
      params: { namespace, timestamp: expect.any(Number), data: channelData },
    });
  });

  it.each([
    ["tools", { event: "tool-started", tool_call_id: "c1" }],
    ["tools", null],
    ["lifecycle", { event: "running" }],
    ["metadata", { run_id: "r" }],
    ["checkpoints", {}],
    ["debug", {}],
  ])("%s %j has no channel", (event, data) => {
    expect(toChannelEvent(event, data)).toBeUndefined();
  });

  it("a run that ends at an interrupt is interrupted", () => {
    expect(
      toChannelEvent("end", { status: "success" }, true)?.params.data
    ).toEqual({ event: "interrupted" });
  });
});

describe("ChannelListeners", () => {
  it("a throwing listener doesn't stop the others", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const channels = new ChannelListeners();
    const after = vi.fn();
    channels.add(() => {
      throw new Error("listener bug");
    });
    channels.add(after);

    channels.emit("custom", 1);

    expect(after).toHaveBeenCalledOnce();
  });
});
