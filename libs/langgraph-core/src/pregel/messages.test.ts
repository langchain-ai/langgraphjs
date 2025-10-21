import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, LLMResult } from "@langchain/core/outputs";
import { Serialized } from "@langchain/core/load/serializable";
import { ChainValues } from "@langchain/core/utils/types";
import { NewTokenIndices } from "@langchain/core/callbacks/base";
import { StreamMessagesHandler } from "./messages.js";
import { TAG_HIDDEN, TAG_NOSTREAM } from "../constants.js";

describe("StreamMessagesHandler", () => {
  describe("constructor", () => {
    it("should properly initialize the handler", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      expect(handler.name).toBe("StreamMessagesHandler");
      expect(handler.streamFn).toBe(streamFn);
      expect(handler.metadatas).toEqual({});
      expect(handler.seen).toEqual({});
      expect(handler.emittedChatModelRunIds).toEqual({});
      expect(handler.stableMessageIdMap).toEqual({});
      expect(handler.lc_prefer_streaming).toBe(true);
    });
  });

  describe("_emit", () => {
    it("should emit a message with metadata", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const meta: [string[], Record<string, unknown>] = [
        ["ns1", "ns2"],
        { name: "test", tags: [] },
      ];
      const message = new AIMessage({ content: "Hello world" });
      const runId = "run-123";

      handler._emit(meta, message, runId);

      expect(streamFn).toHaveBeenCalledWith([
        ["ns1", "ns2"],
        "messages",
        [message, { name: "test", tags: [] }],
      ]);

      // Should store the message in seen if it has an ID
      message.id = "msg-123";
      handler._emit(meta, message, runId);
      expect(handler.seen["msg-123"]).toBe(message);
    });

    it("should deduplicate messages when dedupe=true and message has been seen", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const meta: [string[], Record<string, unknown>] = [
        ["ns1"],
        { name: "test" },
      ];
      const message = new AIMessage({ content: "Hello world", id: "msg-123" });
      const runId = "run-123";

      // First emit should work
      handler._emit(meta, message, runId);
      expect(streamFn).toHaveBeenCalledTimes(1);

      // Second emit with same ID and dedupe=true should be ignored
      streamFn.mockClear();
      handler._emit(meta, message, runId, true);
      expect(streamFn).not.toHaveBeenCalled();
    });

    it("should assign proper ID to tool messages", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const meta: [string[], Record<string, unknown>] = [
        ["ns1"],
        { name: "test" },
      ];
      const toolMessage = new ToolMessage({
        content: "Tool result",
        tool_call_id: "tc-123",
      });
      const runId = "run-456";

      handler._emit(meta, toolMessage, runId);

      // Should assign an ID based on the tool call ID
      expect(toolMessage.id).toBe(`run-${runId}-tool-tc-123`);
      expect(streamFn).toHaveBeenCalled();
    });

    it("should maintain stable message IDs for the same run", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const meta: [string[], Record<string, unknown>] = [
        ["ns1"],
        { name: "test" },
      ];
      const runId = "run-789";

      // First message with auto-generated ID
      const message1 = new AIMessage({ content: "First chunk" });
      handler._emit(meta, message1, runId);
      const stableId = message1.id;

      // Second message with no ID should get the same stable ID
      const message2 = new AIMessage({ content: "Second chunk" });
      handler._emit(meta, message2, runId);

      expect(message2.id).toBe(stableId);
      expect(handler.stableMessageIdMap[runId]).toBe(stableId);
    });
  });

  describe("handleChatModelStart", () => {
    it("should store metadata when provided", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "run-123";
      const metadata = {
        langgraph_checkpoint_ns: "ns1|ns2",
        other_meta: "value",
      };

      handler.handleChatModelStart(
        {} as Serialized, // llm
        [], // messages
        runId,
        undefined, // parentRunId
        {}, // extraParams
        [], // tags
        metadata, // metadata
        "ModelName" // name
      );

      expect(handler.metadatas[runId]).toEqual([
        ["ns1", "ns2"],
        { tags: [], name: "ModelName", ...metadata },
      ]);
    });

    it("should not store metadata when TAG_NOSTREAM is present", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "run-123";
      const metadata = {
        langgraph_checkpoint_ns: "ns1|ns2",
      };

      handler.handleChatModelStart(
        {} as Serialized,
        [],
        runId,
        undefined,
        {},
        [TAG_NOSTREAM], // nostream tag
        metadata,
        "ModelName"
      );

      // Should not store metadata due to TAG_NOSTREAM
      expect(handler.metadatas[runId]).toBeUndefined();
    });
  });

  describe("handleLLMNewToken", () => {
    it("should emit message chunk when metadata exists", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "run-123";
      handler.metadatas[runId] = [["ns1", "ns2"], { name: "test" }];

      // Spy on _emit
      const emitSpy = vi.spyOn(handler, "_emit");

      handler.handleLLMNewToken(
        "token",
        { prompt: 0, completion: 0 } as NewTokenIndices, // idx
        runId
      );

      // Should mark run as emitted
      expect(handler.emittedChatModelRunIds[runId]).toBe(true);

      // Should emit AIMessageChunk when no chunk is provided
      expect(emitSpy).toHaveBeenCalledWith(
        handler.metadatas[runId],
        expect.any(AIMessageChunk),
        runId
      );
      expect(emitSpy.mock.calls[0][1].content).toBe("token");
    });

    it("should emit provided chunk when available", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "run-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      // Spy on _emit
      const emitSpy = vi.spyOn(handler, "_emit");

      // Create a chunk
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({ content: "chunk content" }),
        text: "chunk content", // Add text field to satisfy ChatGenerationChunkFields
      });

      handler.handleLLMNewToken(
        "token",
        { prompt: 0, completion: 0 } as NewTokenIndices,
        runId,
        undefined,
        undefined,
        { chunk } // provide the chunk
      );

      // Should emit the chunk's message
      expect(emitSpy).toHaveBeenCalledWith(
        handler.metadatas[runId],
        chunk.message,
        runId
      );
    });

    it("should not emit when metadata is missing", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "run-123";
      // No metadata for this runId

      // Spy on _emit
      const emitSpy = vi.spyOn(handler, "_emit");

      handler.handleLLMNewToken(
        "token",
        { prompt: 0, completion: 0 } as NewTokenIndices,
        runId
      );

      // Should mark run as emitted
      expect(handler.emittedChatModelRunIds[runId]).toBe(true);

      // But should not call _emit
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleLLMEnd", () => {
    it("should emit message from non-streaming run", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "run-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];
      // Not marked as emitted yet

      // Mock _emit directly instead of spying
      handler._emit = vi.fn();

      const message = new AIMessage({ content: "final result" });
      handler.handleLLMEnd(
        {
          generations: [[{ text: "test output", message }]],
        } as unknown as LLMResult,
        runId
      );

      // Should emit the message with dedupe=true
      expect(handler._emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ content: "final result" }),
        runId,
        true
      );

      // Should clean up
      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should not emit for streaming runs that already emitted", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "run-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];
      // Mark as already emitted
      handler.emittedChatModelRunIds[runId] = true;

      // Mock _emit directly
      handler._emit = vi.fn();

      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                text: "test output",
                message: new AIMessage({ content: "result" }),
              },
            ],
          ],
        } as unknown as LLMResult,
        runId
      );

      // Should not emit anything
      expect(handler._emit).not.toHaveBeenCalled();

      // Should clean up metadata
      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should not emit when metadata is missing", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      // Spy on _emit
      const emitSpy = vi.spyOn(handler, "_emit");

      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                text: "test output",
                message: new AIMessage({ content: "result" }),
              },
            ],
          ],
        } as unknown as LLMResult,
        "run-123"
      );

      // Should not emit anything
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleLLMError", () => {
    it("should clean up metadata on error", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "run-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      handler.handleLLMError(new Error("Test error"), runId);

      // Should clean up metadata
      expect(handler.metadatas[runId]).toBeUndefined();
    });
  });

  describe("handleChainStart", () => {
    it("should store metadata for matching node name", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "chain-123";
      const metadata = {
        langgraph_checkpoint_ns: "ns1|ns2",
        langgraph_node: "NodeName", // Matches name parameter
      };

      handler.handleChainStart(
        {} as Serialized,
        {} as ChainValues,
        runId,
        undefined,
        [],
        metadata,
        undefined,
        "NodeName" // Name matches langgraph_node
      );

      expect(handler.metadatas[runId]).toEqual([
        ["ns1", "ns2"],
        { tags: [], name: "NodeName", ...metadata },
      ]);
    });

    it("should not store metadata when node name doesn't match", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "chain-123";
      const metadata = {
        langgraph_checkpoint_ns: "ns1|ns2",
        langgraph_node: "NodeName", // Doesn't match name parameter
      };

      handler.handleChainStart(
        {} as Serialized,
        {} as ChainValues,
        runId,
        undefined,
        [],
        metadata,
        undefined,
        "DifferentName" // Different from langgraph_node
      );

      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should not store metadata when TAG_HIDDEN is present", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "chain-123";
      const metadata = {
        langgraph_checkpoint_ns: "ns1|ns2",
        langgraph_node: "NodeName",
      };

      handler.handleChainStart(
        {} as Serialized,
        {} as ChainValues,
        runId,
        undefined,
        [TAG_HIDDEN], // Hidden tag
        metadata,
        undefined,
        "NodeName"
      );

      expect(handler.metadatas[runId]).toBeUndefined();
    });
  });

  describe("handleChainEnd", () => {
    it("should emit a single message output", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "chain-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      // Mock _emit directly
      handler._emit = vi.fn();

      const message = new AIMessage({ content: "chain result" });
      handler.handleChainEnd(message, runId);

      // Should emit the message with dedupe=true
      expect(handler._emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ content: "chain result" }),
        runId,
        true
      );

      // Should clean up
      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should emit messages from an array output", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "chain-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      // Mock _emit directly
      handler._emit = vi.fn();

      const message1 = new AIMessage({ content: "result 1" });
      const message2 = new AIMessage({ content: "result 2" });
      const notAMessage = "not a message";

      handler.handleChainEnd([message1, message2, notAMessage], runId);

      // Should emit both messages
      expect(handler._emit).toHaveBeenCalledTimes(2);

      // Verify calls in a way that's less brittle
      const callArgs = (handler._emit as ReturnType<typeof vi.fn>).mock.calls;
      const emittedContents = callArgs.map(
        (args) => (args[1] as BaseMessage).content
      );
      expect(emittedContents).toContain("result 1");
      expect(emittedContents).toContain("result 2");

      // Should clean up
      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should emit messages from object output properties", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "chain-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      // Mock _emit directly
      handler._emit = vi.fn();

      const message = new AIMessage({ content: "direct result" });
      const arrayMessage = new AIMessage({ content: "array result" });

      handler.handleChainEnd(
        {
          directMessage: message,
          arrayMessages: [arrayMessage, "not a message"],
          otherProp: "something else",
        },
        runId
      );

      // Should emit both messages
      expect(handler._emit).toHaveBeenCalledTimes(2);

      // Verify calls in a way that's less brittle
      const callArgs = (handler._emit as ReturnType<typeof vi.fn>).mock.calls;
      const emittedContents = callArgs.map(
        (args) => (args[1] as BaseMessage).content
      );
      expect(emittedContents).toContain("direct result");
      expect(emittedContents).toContain("array result");

      // Should clean up
      expect(handler.metadatas[runId]).toBeUndefined();
    });

    it("should do nothing when metadata is missing", () => {
      const streamFn = vi.fn();
      const handler = new StreamMessagesHandler(streamFn);

      const runId = "chain-123";
      // No metadata for this runId

      // Spy on _emit
      const emitSpy = vi.spyOn(handler, "_emit");

      const message = new AIMessage({ content: "result" });
      handler.handleChainEnd(message, runId);

      // Should not emit anything
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleChainError", () => {
    it("should clean up metadata on error", () => {
      const handler = new StreamMessagesHandler(vi.fn());

      const runId = "chain-123";
      handler.metadatas[runId] = [["ns1"], { name: "test" }];

      handler.handleChainError(new Error("Test error"), runId);

      // Should clean up metadata
      expect(handler.metadatas[runId]).toBeUndefined();
    });
  });
});
