/* eslint-disable import/no-extraneous-dependencies */
/**
 * Minimal fake chat model + createAgent graph that exercises the
 * headless-tool surface of the new `useStream` hook. The model always
 * emits a `get_location` tool call on its first turn and the final
 * "Location received!" message once a tool result is present.
 *
 * The graph definition is intentionally kept separate from the
 * browser-side fixture module (`browser-fixtures.ts`) because the
 * LangChain / LangGraph tool execution engine can't be bundled into
 * the browser test process — graphs stay on the Node-side mock
 * server, only the tool *schema* is shipped to the browser test
 * runner.
 */
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { tool, createAgent } from "langchain";
import { z } from "zod/v4";

const getLocationTool = tool({
  name: "get_location",
  description: "Get the user's current GPS location",
  schema: z.object({ highAccuracy: z.boolean().optional() }),
});

class FakeHeadlessToolModel extends BaseChatModel {
  constructor(fields: BaseChatModelParams = {}) {
    super(fields);
  }

  _llmType() {
    return "fake-headless-tool-model";
  }

  _combineLLMOutput() {
    return [];
  }

  #needsToolCall(messages?: BaseMessage[]) {
    return !messages?.some((m) => m.getType() === "tool");
  }

  async _generate(messages?: BaseMessage[]): Promise<ChatResult> {
    const msg = this.#needsToolCall(messages)
      ? new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "get_location",
              args: { highAccuracy: false },
              id: "tool-call-browser-1",
              type: "tool_call",
            },
          ],
        })
      : new AIMessage("Location received!");
    return {
      generations: [{ text: (msg.content as string) || "", message: msg }],
    };
  }

  async *_streamResponseChunks(messages?: BaseMessage[]) {
    if (this.#needsToolCall(messages)) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              name: "get_location",
              args: JSON.stringify({ highAccuracy: false }),
              id: "tool-call-browser-1",
              index: 0,
              type: "tool_call_chunk",
            },
          ],
        }),
        text: "",
      });
    } else {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk("Location received!"),
        text: "Location received!",
      });
    }
  }

  bindTools() {
    return this;
  }
}

const checkpointer = new MemorySaver();

export const graph = createAgent({
  model: new FakeHeadlessToolModel(),
  tools: [getLocationTool],
  checkpointer,
});
