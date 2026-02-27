import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import {
  _addInlineAgentName,
  _removeInlineAgentName,
  _addSystemPromptAgentName,
} from "../../prebuilt/agentName.js";

describe("_addInlineAgentName", () => {
  it("should return non-AI messages unchanged", () => {
    const humanMessage = new HumanMessage("Hello");
    const result = _addInlineAgentName(humanMessage);
    expect(result).toEqual(humanMessage);
  });

  it("should return AI messages with no name unchanged", () => {
    const aiMessage = new AIMessage("Hello world");
    const result = _addInlineAgentName(aiMessage);
    expect(result).toEqual(aiMessage);
  });

  it("should format AI messages with name and content tags", () => {
    const aiMessage = new AIMessage({
      content: "Hello world",
      name: "assistant",
    });
    const result = _addInlineAgentName(aiMessage);
    expect(result.content).toEqual(
      "<name>assistant</name><content>Hello world</content>"
    );
  });

  it("should handle content blocks correctly", () => {
    const contentBlocks = [
      { type: "text", text: "Hello world" },
      { type: "image", image_url: "http://example.com/image.jpg" },
    ];
    const aiMessage = new AIMessage({
      content: contentBlocks,
      name: "assistant",
    });
    const result = _addInlineAgentName(aiMessage);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "<name>assistant</name><content>Hello world</content>",
      },
      { type: "image", image_url: "http://example.com/image.jpg" },
    ]);
  });

  it("should handle content blocks without text blocks", () => {
    const contentBlocks = [
      { type: "image", image_url: "http://example.com/image.jpg" },
      { type: "file", file_url: "http://example.com/document.pdf" },
    ];
    const expectedContentBlocks = [
      { type: "text", text: "<name>assistant</name><content></content>" },
      ...contentBlocks,
    ];
    const aiMessage = new AIMessage({
      content: contentBlocks,
      name: "assistant",
    });
    const result = _addInlineAgentName(aiMessage);
    expect(result.content).toEqual(expectedContentBlocks);
  });
});

describe("_removeInlineAgentName", () => {
  it("should return non-AI messages unchanged", () => {
    const humanMessage = new HumanMessage("Hello");
    const result = _removeInlineAgentName(humanMessage);
    expect(result).toEqual(humanMessage);
  });

  it("should return messages with empty content unchanged", () => {
    const aiMessage = new AIMessage({
      content: "",
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);
    expect(result).toEqual(aiMessage);
  });

  it("should return messages without name/content tags unchanged", () => {
    const aiMessage = new AIMessage({
      content: "Hello world",
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);
    expect(result).toEqual(aiMessage);
  });

  it("should correctly extract content from tags", () => {
    const aiMessage = new AIMessage({
      content: "<name>assistant</name><content>Hello world</content>",
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);
    expect(result.content).toEqual("Hello world");
    expect(result.name).toEqual("assistant");
  });

  it("should handle content blocks correctly", () => {
    const contentBlocks = [
      {
        type: "text",
        text: "<name>assistant</name><content>Hello world</content>",
      },
      { type: "image", image_url: "http://example.com/image.jpg" },
    ];
    const aiMessage = new AIMessage({
      content: contentBlocks,
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);

    const expectedContent = [
      { type: "text", text: "Hello world" },
      { type: "image", image_url: "http://example.com/image.jpg" },
    ];
    expect(result.content).toEqual(expectedContent);
    expect(result.name).toEqual("assistant");
  });

  it("should handle content blocks with empty text content", () => {
    const contentBlocks = [
      { type: "text", text: "<name>assistant</name><content></content>" },
      { type: "image", image_url: "http://example.com/image.jpg" },
      { type: "file", file_url: "http://example.com/document.pdf" },
    ];
    const expectedContentBlocks = contentBlocks.slice(1);
    const aiMessage = new AIMessage({
      content: contentBlocks,
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);
    expect(result.content).toEqual(expectedContentBlocks);
  });

  it("should handle multiline content", () => {
    const multilineContent = `<name>assistant</name><content>This is
a multiline
message</content>`;
    const aiMessage = new AIMessage({
      content: multilineContent,
      name: "assistant",
    });
    const result = _removeInlineAgentName(aiMessage);
    expect(result.content).toEqual("This is\na multiline\nmessage");
  });
});

describe("_addSystemPromptAgentName", () => {
  it("prepends a SystemMessage when no system message exists", () => {
    const messages = [new HumanMessage("Hello")];
    const result = _addSystemPromptAgentName(messages, "researcher");
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    const sysContent = (result[0] as SystemMessage).content as string;
    expect(sysContent).toContain("researcher");
    expect(sysContent).toContain("<name>researcher</name>");
    expect(result[1]).toEqual(messages[0]);
  });

  it("appends instruction to an existing string SystemMessage", () => {
    const messages = [
      new SystemMessage("You are a helpful assistant."),
      new HumanMessage("Hello"),
    ];
    const result = _addSystemPromptAgentName(messages, "researcher");
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    const sysContent = (result[0] as SystemMessage).content as string;
    expect(sysContent).toContain("You are a helpful assistant.");
    expect(sysContent).toContain("<name>researcher</name>");
    // Rest of messages unchanged
    expect(result[1]).toEqual(messages[1]);
  });

  it("does not modify past AIMessages", () => {
    const aiMsg = new AIMessage({ content: "I did some research", name: "researcher" });
    const messages = [
      new SystemMessage("You are a supervisor."),
      new HumanMessage("What did you find?"),
      aiMsg,
    ];
    const result = _addSystemPromptAgentName(messages, "supervisor");
    // Past AIMessage must be the same object, untouched
    expect(result[2]).toBe(aiMsg);
    expect((result[2] as AIMessage).content).toEqual("I did some research");
  });

  it("prepends a new SystemMessage when existing system message has non-string content", () => {
    const existingSystem = new SystemMessage({
      content: [{ type: "text", text: "You are helpful." }],
    });
    const messages = [existingSystem, new HumanMessage("Hello")];
    const result = _addSystemPromptAgentName(messages, "researcher");
    // Should prepend a new SystemMessage before the existing one
    expect(result).toHaveLength(3);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    const sysContent = (result[0] as SystemMessage).content as string;
    expect(sysContent).toContain("<name>researcher</name>");
    // Original system message preserved
    expect(result[1]).toBe(existingSystem);
  });
});
