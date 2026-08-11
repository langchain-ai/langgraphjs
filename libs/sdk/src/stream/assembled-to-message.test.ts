import { describe, expect, it } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";

import { assembledToBaseMessage } from "./assembled-to-message.js";

/**
 * Regression tests for issue #2570: stream.mjs emits dirty tool_call args
 * from concatenated chunks.
 *
 * The bug: when a provider re-emits the cumulative args per chunk
 * (e.g. an OpenAI-compatible proxy with `reasoning_split`), the
 * `extractToolCallChunks` function preserves EVERY chunk in the
 * output array. The stream consumer then concatenates args, producing
 * `"{}{}{}"` instead of `"{}"`.
 *
 * The fix: dedupe chunks by `index` (or `id` when index is missing)
 * so only the last chunk per tool call survives. The last chunk per
 * index carries the cumulative args (per the bug report's observation).
 */

describe("extractToolCallChunks dedup (regression for #2570)", () => {
  it("preserves the last chunk per index when args are cumulative duplicates", () => {
    // Simulate the bug report: 3 chunks for index 0 with cumulative args
    // (the OpenAI-compatible proxy case).
    const result = assembledToBaseMessage({
      id: "msg_x",
      role: "ai",
      blocks: [
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: "{}",
          index: 0,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: "{}",
          index: 0,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: "{}",
          index: 0,
        },
      ],
    });

    // The user-visible symptom: args ends up as "{}{}{}" when
    // chunk consumers concatenate. The fix should produce ONE chunk
    // with args="{}" (the last seen snapshot).
    expect(result).toBeInstanceOf(AIMessageChunk);
    const msg = result as AIMessageChunk;
    const chunks = msg.tool_call_chunks ?? [];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.args).toBe("{}");
  });

  it("preserves incremental args (the normal case, not cumulative)", () => {
    // The normal protocol case: each chunk has a true delta.
    const result = assembledToBaseMessage({
      id: "msg_x",
      role: "ai",
      blocks: [
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: '{"q":',
          index: 0,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: '"test"}',
          index: 0,
        },
      ],
    });

    const msg = result as AIMessageChunk;
    const chunks = msg.tool_call_chunks ?? [];
    // Dedup keeps the LAST chunk per index. The last chunk has
    // args='"test"}' which IS the final cumulative args. Consumers
    // that re-concatenate would still get '"test"}' (the last chunk),
    // not '"q":"test"}' (the concatenation of both).
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.args).toBe('"test"}');
  });

  it("keeps separate chunks for distinct tool call indices", () => {
    // Two parallel tool calls (index 0 and index 1) should NOT be merged.
    const result = assembledToBaseMessage({
      id: "msg_x",
      role: "ai",
      blocks: [
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: '{"q":',
          index: 0,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_02",
          name: "calc",
          args: '{"e":',
          index: 1,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: '"test"}',
          index: 0,
        },
        {
          type: "tool_call_chunk",
          id: "toolu_02",
          name: "calc",
          args: '"1"}',
          index: 1,
        },
      ],
    });

    const msg = result as AIMessageChunk;
    const chunks = msg.tool_call_chunks ?? [];
    expect(chunks).toHaveLength(2);
    // Order preserved
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.args).toBe('"test"}');
    expect(chunks[1]?.index).toBe(1);
    expect(chunks[1]?.args).toBe('"1"}');
  });

  it("falls back to id when index is missing", () => {
    // Some providers don't include an index. Dedup by id (tool call id).
    const result = assembledToBaseMessage({
      id: "msg_x",
      role: "ai",
      blocks: [
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: "{}",
        },
        {
          type: "tool_call_chunk",
          id: "toolu_01",
          name: "search",
          args: "{}",
        },
        {
          type: "tool_call_chunk",
          id: "toolu_02",
          name: "calc",
          args: "{}",
        },
      ],
    });

    const msg = result as AIMessageChunk;
    const chunks = msg.tool_call_chunks ?? [];
    expect(chunks).toHaveLength(2);
    // Both toolu_01 chunks dedup to one; toolu_02 standalone
    const ids = chunks.map((c) => c.id);
    expect(ids).toEqual(["toolu_01", "toolu_02"]);
  });

});
