import { describe, expect, it, vi } from "vitest";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { ContentBlock } from "@langchain/protocol";
import { assembledToBaseMessage } from "./assembled-to-message.js";

describe("assembledToBaseMessage — tool_call / tool_call_chunk handling", () => {
  // These tests pin the WORKAROUND for langchain-core's
  // ``AIMessageChunk`` constructor, which discards caller-supplied
  // ``tool_calls`` and rebuilds them from ``tool_call_chunks`` via
  // ``collapseToolCallChunks``. Without re-encoding finalized tool_call
  // blocks as chunks, parallel-tool-call UIs render incrementally
  // wrong (only the streaming call is visible, finished ones disappear
  // until message-finish).

  it("pure-chunks: forwards tool_call_chunk blocks unmodified", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_call_chunk",
        id: "a",
        name: "search",
        args: '{"q":',
        index: 0,
      } as ContentBlock,
    ];
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    expect(msg).toBeInstanceOf(AIMessageChunk);
    expect(msg.tool_call_chunks).toHaveLength(1);
    expect(msg.tool_call_chunks?.[0]).toMatchObject({
      id: "a",
      name: "search",
      args: '{"q":',
    });
  });

  it("pure-finalized: emits AIMessageChunk with re-encoded chunks and intact args", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_call",
        id: "a",
        name: "search",
        args: { q: "weather" },
      } as ContentBlock,
    ];
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    // Re-encoded chunk forces AIMessageChunk path.
    expect(msg).toBeInstanceOf(AIMessageChunk);
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls?.[0]).toMatchObject({
      id: "a",
      name: "search",
      args: { q: "weather" },
    });
  });

  it("mixed finalized+streaming: complete tool_calls survives constructor's collapse", () => {
    // The bug scenario: block A is fully done (tool_call), block B is
    // still streaming (tool_call_chunk). Without re-encoding A as a
    // chunk, A.tool_calls would be dropped by AIMessageChunk and the
    // UI loses the finished card mid-stream.
    const blocks: ContentBlock[] = [
      {
        type: "tool_call",
        id: "A",
        name: "search",
        args: { q: "weather" },
      } as ContentBlock,
      {
        type: "tool_call_chunk",
        id: "B",
        name: "search",
        args: '{"q":"',
        index: 1,
      } as ContentBlock,
    ];
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    expect(msg).toBeInstanceOf(AIMessageChunk);
    expect(msg.tool_call_chunks).toHaveLength(2);
    // The completed call (A) must be visible on tool_calls during the
    // stream, with args intact — that's the regression this PR fixes.
    // ``parsePartialJson`` may also surface the streaming call (B) as
    // a partial tool_call with degraded args; we only pin behavior for
    // the finished one to keep the test resilient to upstream
    // partial-parse changes.
    const finishedCalls = msg.tool_calls ?? [];
    const callA = finishedCalls.find((tc) => tc.id === "A");
    expect(callA).toMatchObject({
      id: "A",
      name: "search",
      args: { q: "weather" },
    });
  });

  it("four-parallel finalized: every completed call appears on tool_calls", () => {
    // Matches the original symptom: "only one Subagent Task card during
    // streaming, then four at the end".
    const blocks: ContentBlock[] = [0, 1, 2, 3].map(
      (i) =>
        ({
          type: "tool_call",
          id: `tc-${i}`,
          name: "task",
          args: { description: `subtask ${i}` },
        }) as ContentBlock
    );
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    expect(msg.tool_calls).toHaveLength(4);
    expect(msg.tool_calls?.map((tc) => tc.id)).toEqual([
      "tc-0",
      "tc-1",
      "tc-2",
      "tc-3",
    ]);
  });

  it("no tool blocks: emits AIMessage (not AIMessageChunk)", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hi" } as ContentBlock,
    ];
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    expect(msg).toBeInstanceOf(AIMessage);
    expect(msg).not.toBeInstanceOf(AIMessageChunk);
  });

  it("args=string (pre-stringified) is forwarded without double-encoding", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_call",
        id: "a",
        name: "t",
        args: '{"q":"x"}' as unknown as Record<string, unknown>,
      } as ContentBlock,
    ];
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    expect(msg.tool_calls?.[0]).toMatchObject({ id: "a", args: { q: "x" } });
  });

  it("cyclic args: warns and surfaces an invalid_tool_call instead of throwing", () => {
    const cyclic: Record<string, unknown> = { k: 1 };
    cyclic.self = cyclic;
    const blocks: ContentBlock[] = [
      {
        type: "tool_call",
        id: "bad",
        name: "t",
        args: cyclic,
      } as ContentBlock,
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg = assembledToBaseMessage({
      role: "ai",
      blocks,
    }) as AIMessageChunk;
    try {
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/failed to JSON-stringify/);
      // Cyclic args degrade to "" — parsePartialJson treats "" as "{}",
      // so the call surfaces with empty args (still better than blowing
      // up the stream).
      const allCalls = [
        ...(msg.tool_calls ?? []),
        ...(msg.invalid_tool_calls ?? []),
      ];
      expect(allCalls.find((c) => c.id === "bad")).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});
