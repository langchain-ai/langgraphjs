import { describe, it, expect } from "vitest";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { ChatGeneration, ChatGenerationChunk } from "@langchain/core/outputs";

import { toEventStream } from "../pregel/stream.js";
import { StreamMessagesHandler } from "../pregel/messages.js";
import type { StreamChunk } from "../pregel/stream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

async function collectSSE(
  stream: ReadableStream<Uint8Array>
): Promise<{ event: string; data: unknown }[]> {
  const reader = stream.getReader();
  let buf = "";
  const events: { event: string; data: unknown }[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines
    const parts = buf.split("\n\n");
    buf = parts.pop()!;
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = "";
      let data: unknown = null;
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
      }
      events.push({ event, data });
    }
  }
  return events;
}

async function* yieldChunks(
  chunks: StreamChunk[]
): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

// ---------------------------------------------------------------------------
// toEventStream — strip empty properties
// ---------------------------------------------------------------------------

describe("toEventStream", () => {
  describe("strip empty properties", () => {
    it("should omit tool_calls, invalid_tool_calls, tool_call_chunks, additional_kwargs when empty", async () => {
      const msg = new AIMessageChunk({ content: "Hi", id: "msg_01" });
      const metadata = { langgraph_node: "agent" };
      const chunks: StreamChunk[] = [[[], "messages", [msg, metadata]]];

      const events = await collectSSE(toEventStream(yieldChunks(chunks)));

      expect(events).toHaveLength(1);
      const [serializedMsg] = events[0].data as [
        Record<string, unknown>,
        unknown
      ];

      expect(serializedMsg.content).toBe("Hi");
      expect(serializedMsg.type).toBe("ai");
      expect(serializedMsg).not.toHaveProperty("tool_calls");
      expect(serializedMsg).not.toHaveProperty("invalid_tool_calls");
      expect(serializedMsg).not.toHaveProperty("tool_call_chunks");
      expect(serializedMsg).not.toHaveProperty("additional_kwargs");
    });

    it("should preserve non-empty tool_calls", async () => {
      const msg = new AIMessageChunk({
        content: "",
        id: "msg_02",
        tool_calls: [
          { name: "search", args: { q: "hi" }, id: "tc_1", type: "tool_call" },
        ],
      });
      const chunks: StreamChunk[] = [[[], "messages", [msg, {}]]];
      const events = await collectSSE(toEventStream(yieldChunks(chunks)));

      const [serializedMsg] = events[0].data as [
        Record<string, unknown>,
        unknown
      ];
      expect(serializedMsg.tool_calls).toHaveLength(1);
    });

    it("should strip empty arrays from values events too", async () => {
      const state = {
        messages: [
          {
            type: "ai",
            content: "hello",
            tool_calls: [],
            invalid_tool_calls: [],
            additional_kwargs: {},
          },
        ],
      };
      const chunks: StreamChunk[] = [[[], "values", state]];
      const events = await collectSSE(toEventStream(yieldChunks(chunks)));

      const data = events[0].data as { messages: Record<string, unknown>[] };
      expect(data.messages[0]).not.toHaveProperty("tool_calls");
      expect(data.messages[0]).not.toHaveProperty("invalid_tool_calls");
      expect(data.messages[0]).not.toHaveProperty("additional_kwargs");
    });
  });

  describe("skipSubgraphValues", () => {
    it("should drop values events with non-empty namespace when enabled", async () => {
      const chunks: StreamChunk[] = [
        [[], "values", { messages: ["root state"] }],
        [
          ["tools:call_1", "model:task_1"],
          "values",
          { messages: ["sub state"] },
        ],
        [[], "updates", { node: "data" }],
      ];

      const events = await collectSSE(
        toEventStream(yieldChunks(chunks), { skipSubgraphValues: true })
      );

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("values");
      expect(events[1].event).toBe("updates");
    });

    it("should keep root values events", async () => {
      const chunks: StreamChunk[] = [[[], "values", { messages: ["root"] }]];

      const events = await collectSSE(
        toEventStream(yieldChunks(chunks), { skipSubgraphValues: true })
      );

      expect(events).toHaveLength(1);
    });

    it("should pass all events through when disabled (default)", async () => {
      const chunks: StreamChunk[] = [
        [[], "values", { messages: ["root"] }],
        [["tools:call_1"], "values", { messages: ["sub"] }],
      ];

      const events = await collectSSE(toEventStream(yieldChunks(chunks)));
      expect(events).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// StreamMessagesHandler — metadata deduplication
// ---------------------------------------------------------------------------

describe("StreamMessagesHandler", () => {
  describe("metadata deduplication for LLM streaming", () => {
    it("preserves full metadata on every chunk by default (v1)", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      );

      const runId = "run-v1";
      const metadata = {
        langgraph_checkpoint_ns: "agent:task_v1",
        langgraph_node: "model",
        langgraph_step: 1,
      };

      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId,
        undefined,
        undefined,
        [],
        metadata,
        "model"
      );

      for (const token of ["Hello", " ", "world"]) {
        const chunk = new ChatGenerationChunk({
          message: new AIMessageChunk({ content: token, id: "msg_v1" }),
          text: token,
        });
        handler.handleLLMNewToken(
          token,
          { prompt: 0, completion: 0 },
          runId,
          undefined,
          undefined,
          { chunk }
        );
      }

      expect(collected).toHaveLength(3);
      for (const idx of [0, 1, 2]) {
        const [, , [, meta]] = collected[idx] as [
          string[],
          string,
          [unknown, Record<string, unknown> | null]
        ];
        expect(meta).not.toBeNull();
      }
    });

    it("sends full metadata with first chunk, null for subsequent chunks in v2", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      , { dedupeMetadata: true });

      const runId = "run-123";
      const metadata = {
        langgraph_checkpoint_ns: "agent:task_1",
        langgraph_node: "model",
        langgraph_step: 1,
        ls_provider: "anthropic",
        ls_model_name: "claude-haiku-4-5",
      };

      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId,
        undefined,
        undefined,
        ["tag1"],
        metadata,
        "model"
      );

      // Simulate 3 streaming tokens
      for (const token of ["Hello", " ", "world"]) {
        const chunk = new ChatGenerationChunk({
          message: new AIMessageChunk({ content: token, id: "msg_01" }),
          text: token,
        });
        handler.handleLLMNewToken(
          token,
          { prompt: 0, completion: 0 },
          runId,
          undefined,
          undefined,
          { chunk }
        );
      }

      expect(collected).toHaveLength(3);

      // First chunk: full metadata
      const [, , [, meta1]] = collected[0] as [
        string[],
        string,
        [unknown, Record<string, unknown> | null]
      ];
      expect(meta1).not.toBeNull();
      expect(meta1!.ls_provider).toBe("anthropic");
      expect(meta1!.langgraph_node).toBe("model");

      // Second and third chunks: null metadata
      for (const idx of [1, 2]) {
        const [, , [, metaN]] = collected[idx] as [
          string[],
          string,
          [unknown, Record<string, unknown> | null]
        ];
        expect(metaN).toBeNull();
      }
    });

    it("sends full metadata for non-streaming (invoke) calls", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      );

      const runId = "run-456";
      const metadata = {
        langgraph_checkpoint_ns: "agent:task_2",
        langgraph_node: "model",
        langgraph_step: 2,
        ls_provider: "openai",
      };

      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId,
        undefined,
        undefined,
        [],
        metadata,
        "model"
      );

      // Non-streaming: handleLLMEnd fires without handleLLMNewToken
      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                text: "Hi!",
                message: new AIMessage({ content: "Hi!", id: "msg_02" }),
              } as ChatGeneration,
            ],
          ],
        },
        runId
      );

      expect(collected).toHaveLength(1);
      const [, , [, meta]] = collected[0] as [
        string[],
        string,
        [unknown, Record<string, unknown> | null]
      ];
      expect(meta).not.toBeNull();
      expect(meta!.ls_provider).toBe("openai");
    });

    it("sends full metadata for each distinct chain-output message", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      );

      const runId = "run-789";
      const metadata = {
        langgraph_checkpoint_ns: "node:task_3",
        langgraph_node: "node",
        langgraph_step: 1,
      };

      handler.handleChainStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        {},
        runId,
        undefined,
        [],
        metadata,
        undefined,
        "node"
      );

      // Chain outputs two distinct messages
      handler.handleChainEnd(
        {
          messages: [
            new AIMessage({ content: "first", id: "msg_A" }),
            new AIMessage({ content: "second", id: "msg_B" }),
          ],
        },
        runId
      );

      expect(collected).toHaveLength(2);

      // Both messages should have full metadata
      for (const idx of [0, 1]) {
        const [, , [, meta]] = collected[idx] as [
          string[],
          string,
          [unknown, Record<string, unknown> | null]
        ];
        expect(meta).not.toBeNull();
        expect(meta!.langgraph_node).toBe("node");
      }
    });

    it("resets metadata tracking between separate LLM runs", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      , { dedupeMetadata: true });

      const metadata = {
        langgraph_checkpoint_ns: "agent:task_4",
        langgraph_node: "model",
        langgraph_step: 1,
      };

      // First LLM run
      const runId1 = "run-aaa";
      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId1,
        undefined,
        undefined,
        [],
        metadata,
        "model"
      );

      for (const token of ["A", "B"]) {
        const chunk = new ChatGenerationChunk({
          message: new AIMessageChunk({ content: token, id: "msg_run1" }),
          text: token,
        });
        handler.handleLLMNewToken(
          token,
          { prompt: 0, completion: 0 },
          runId1,
          undefined,
          undefined,
          { chunk }
        );
      }
      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                text: "AB",
                message: new AIMessageChunk({ content: "AB", id: "msg_run1" }),
              } as ChatGeneration,
            ],
          ],
        },
        runId1
      );

      // Second LLM run
      const runId2 = "run-bbb";
      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId2,
        undefined,
        undefined,
        [],
        {
          ...metadata,
          langgraph_step: 2,
          langgraph_checkpoint_ns: "agent:task_5",
        },
        "model"
      );

      for (const token of ["C", "D"]) {
        const chunk = new ChatGenerationChunk({
          message: new AIMessageChunk({ content: token, id: "msg_run2" }),
          text: token,
        });
        handler.handleLLMNewToken(
          token,
          { prompt: 0, completion: 0 },
          runId2,
          undefined,
          undefined,
          { chunk }
        );
      }

      // run1: 2 chunks, run2: 2 chunks = 4 total
      expect(collected).toHaveLength(4);

      // First chunk of each run has metadata; second has null
      const getMeta = (i: number) =>
        (collected[i] as [string[], string, [unknown, unknown]])[2][1];

      expect(getMeta(0)).not.toBeNull(); // run1 chunk 1
      expect(getMeta(1)).toBeNull(); // run1 chunk 2
      expect(getMeta(2)).not.toBeNull(); // run2 chunk 1
      expect(getMeta(3)).toBeNull(); // run2 chunk 2
    });
  });

  describe("cleanup on error", () => {
    it("cleans up metadata tracking on LLM error", () => {
      const collected: StreamChunk[] = [];
      const handler = new StreamMessagesHandler((chunk) =>
        collected.push(chunk)
      );
      const runId = "run-err";
      const metadata = {
        langgraph_checkpoint_ns: "",
        langgraph_node: "model",
        langgraph_step: 1,
      };
      handler.handleChatModelStart(
        { id: ["test"], lc: 1, type: "not_implemented" },
        [],
        runId,
        undefined,
        undefined,
        [],
        metadata,
        "model"
      );

      // Emit one token then error
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({ content: "partial", id: "msg_e" }),
        text: "partial",
      });
      handler.handleLLMNewToken(
        "partial",
        { prompt: 0, completion: 0 },
        runId,
        undefined,
        undefined,
        { chunk }
      );
      handler.handleLLMError(new Error("boom"), runId);

      expect(collected).toHaveLength(1);
      // Internal state should be cleaned up (no leftover metadata references)
      expect(handler.metadatas[runId]).toBeUndefined();
    });
  });
});
