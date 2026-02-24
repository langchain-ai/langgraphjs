import { describe, it, expect } from "vitest";
import type { Serialized } from "@langchain/core/load/serializable";
import { StreamToolsHandler } from "../../pregel/stream.js";
import { TAG_HIDDEN } from "../../constants.js";

describe("StreamToolsHandler", () => {
  it("emits on_tool_start with namespace and toolCallId", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));

    handler.handleToolStart(
      {} as Serialized,
      '{"query":"SF"}',
      "run-1",
      undefined,
      [],
      { langgraph_checkpoint_ns: "a|b" },
      "weather",
      "call_1234"
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([
      ["a", "b"],
      "tools",
      {
        event: "on_tool_start",
        toolCallId: "call_1234",
        name: "weather",
        input: '{"query":"SF"}',
      },
    ]);
  });

  it("does not emit when metadata is undefined", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));

    handler.handleToolStart(
      {} as Serialized,
      "{}",
      "run-1",
      undefined,
      undefined,
      undefined,
      "tool"
    );

    expect(chunks).toHaveLength(0);
  });

  it("does not emit when tags include TAG_HIDDEN", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));

    handler.handleToolStart(
      {} as Serialized,
      "{}",
      "run-1",
      undefined,
      [TAG_HIDDEN],
      {},
      "tool",
      "call_1"
    );

    expect(chunks).toHaveLength(0);
  });

  it("emits on_tool_event when run is known", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));

    handler.handleToolStart(
      {} as Serialized,
      "{}",
      "run-1",
      undefined,
      [],
      {},
      "my_tool",
      "call_1"
    );
    handler.handleToolEvent({ partial: "data" }, "run-1");

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual([
      [],
      "tools",
      {
        event: "on_tool_event",
        toolCallId: "call_1",
        name: "my_tool",
        data: { partial: "data" },
      },
    ]);
  });

  it("emits on_tool_end and clears run", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));

    handler.handleToolStart(
      {} as Serialized,
      "{}",
      "run-1",
      undefined,
      [],
      {},
      "my_tool",
      "call_1"
    );
    handler.handleToolEnd({ result: 42 }, "run-1");

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual([
      [],
      "tools",
      {
        event: "on_tool_end",
        toolCallId: "call_1",
        name: "my_tool",
        output: { result: 42 },
      },
    ]);
    handler.handleToolEvent("no-op", "run-1");
    expect(chunks).toHaveLength(2);
  });

  it("emits on_tool_error and clears run", () => {
    const chunks: unknown[] = [];
    const handler = new StreamToolsHandler((chunk) => chunks.push(chunk));
    const err = new Error("tool failed");

    handler.handleToolStart(
      {} as Serialized,
      "{}",
      "run-1",
      undefined,
      [],
      {},
      "my_tool",
      "call_1"
    );
    handler.handleToolError(err, "run-1");

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual([
      [],
      "tools",
      {
        event: "on_tool_error",
        toolCallId: "call_1",
        name: "my_tool",
        error: err,
      },
    ]);
  });
});
