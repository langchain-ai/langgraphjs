import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { Message } from "../types.messages.js";
import { ensureMessageInstances } from "./message-coercion.js";

describe("stream message coercion", () => {
  it("hydrates AI text from snake_case content_blocks when content is empty", () => {
    const [message] = ensureMessageInstances([
      {
        type: "ai",
        id: "ai-final",
        content: [],
        content_blocks: [{ type: "text", text: "Final synthesis" }],
        response_metadata: { output_version: "v1" },
        tool_calls: [],
        invalid_tool_calls: [],
      } as unknown as Message,
    ]);

    expect(message).toBeInstanceOf(AIMessage);
    expect(message.text).toBe("Final synthesis");
  });

  it("hydrates AI text from snake_case content_blocks when content has only empty text", () => {
    const [message] = ensureMessageInstances([
      {
        type: "ai",
        id: "ai-empty-content",
        content: [{ type: "text", text: "" }],
        content_blocks: [{ type: "text", text: "Recovered text" }],
        response_metadata: { output_version: "v1" },
        tool_calls: [],
        invalid_tool_calls: [],
      } as unknown as Message,
    ]);

    expect(message).toBeInstanceOf(AIMessage);
    expect(message.text).toBe("Recovered text");
  });
});
