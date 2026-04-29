import type {
  ThreadMessageLike,
  ImageMessagePart,
  FileMessagePart,
  ReasoningMessagePart,
  TextMessagePart,
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import type { BaseMessage, ContentBlock } from "@langchain/core/messages";

function isComposerTextPart(part: unknown): part is TextMessagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isComposerImagePart(part: unknown): part is ImageMessagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "image" &&
    "image" in part &&
    typeof part.image === "string"
  );
}

function isComposerFilePart(part: unknown): part is FileMessagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "file"
  );
}

export function getTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is ContentBlock.Text =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function getImageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;

  return content.filter(
    (part): part is ContentBlock.Multimodal.Image =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "image_url" &&
      "image_url" in part,
  ).length;
}

function getImageUrl(part: ContentBlock[]): string[] {
  return part.flatMap((block) => {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      return [];
    }

    if (block.type === "image_url" && "image_url" in block) {
      const image = block.image_url;
      if (typeof image === "string") return [image];
      if (
        typeof image === "object" &&
        image !== null &&
        "url" in image &&
        typeof image.url === "string"
      ) {
        return [image.url];
      }
      return [];
    }

    if (block.type === "image") {
      if ("url" in block && typeof block.url === "string") return [block.url];
      if ("data" in block && typeof block.data === "string")
        return [block.data];
    }

    return [];
  });
}

function toUserThreadContent(
  content: string | ContentBlock[],
): ThreadUserMessagePart[] {
  const text = getTextFromContent(content).trim();
  const imageCount = getImageCount(content);
  const parts: ThreadUserMessagePart[] = [];

  if (text.length > 0) {
    parts.push({ text, type: "text" });
  }

  if (imageCount > 0) {
    parts.push({
      text:
        imageCount === 1
          ? "[Image attached]"
          : `[${imageCount} images attached]`,
      type: "text",
    });
  }

  if (parts.length === 0) {
    parts.push({ text: "", type: "text" });
  }

  return parts;
}

type LangChainToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

type LangChainToolMessage = BaseMessage & {
  type: "tool";
  artifact?: unknown;
  status?: "success" | "error";
  tool_call_id: string;
};

function isLangChainToolCall(value: unknown): value is LangChainToolCall {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "args" in value &&
    typeof value.args === "object" &&
    value.args !== null
  );
}

function isLangChainToolMessage(
  message: BaseMessage,
): message is LangChainToolMessage {
  return message.type === "tool" && "tool_call_id" in message;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function toReadonlyJsonObject(value: unknown): ToolCallMessagePart["args"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(value)) as ToolCallMessagePart["args"];
  } catch {
    return {};
  }
}

function toToolResult(message: LangChainToolMessage): unknown {
  if (message.artifact !== undefined) return message.artifact;

  const text = getTextFromContent(message.content).trim();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toAssistantThreadContent(
  message: BaseMessage,
): ThreadAssistantMessagePart[] {
  const parts: ThreadAssistantMessagePart[] = [];
  const content = message.contentBlocks;

  for (const part of content) {
    if (typeof part !== "object" || part === null || !("type" in part))
      continue;

    if (
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      if (part.text.trim().length > 0) {
        parts.push({ text: part.text, type: "text" });
      }
      continue;
    }

    if (
      part.type === "reasoning" &&
      "reasoning" in part &&
      typeof part.reasoning === "string" &&
      part.reasoning.trim().length > 0
    ) {
      const reasoningPart: ReasoningMessagePart = {
        text: part.reasoning,
        type: "reasoning",
      };
      parts.push(reasoningPart);
      continue;
    }

    if (
      part.type === "tool_call" &&
      "name" in part &&
      typeof part.name === "string"
    ) {
      const toolCallPart: ToolCallMessagePart = {
        args: toReadonlyJsonObject("args" in part ? part.args : {}),
        argsText: safeJsonStringify("args" in part ? part.args : {}),
        toolCallId:
          typeof part.id === "string"
            ? part.id
            : `${message.id ?? "ai"}-${parts.length}`,
        toolName: part.name,
        type: "tool-call",
      };
      parts.push(toolCallPart);
      continue;
    }

    if (part.type === "image") {
      for (const image of getImageUrl([part])) {
        parts.push({ image, type: "image" });
      }
    }
  }

  const toolCalls = "tool_calls" in message ? message.tool_calls : undefined;
  if (Array.isArray(toolCalls)) {
    const existingIds = new Set(
      parts
        .filter(
          (part): part is ToolCallMessagePart => part.type === "tool-call",
        )
        .map((part) => part.toolCallId),
    );

    toolCalls.filter(isLangChainToolCall).forEach((toolCall, index) => {
      const toolCallId = toolCall.id ?? `${message.id ?? "ai"}-tool-${index}`;
      if (existingIds.has(toolCallId)) return;

      parts.push({
        args: toReadonlyJsonObject(toolCall.args),
        argsText: safeJsonStringify(toolCall.args),
        toolCallId,
        toolName: toolCall.name,
        type: "tool-call",
      });
    });
  }

  return parts;
}

function attachToolResult(
  threadMessages: ThreadMessageLike[],
  toolMessage: LangChainToolMessage,
) {
  for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
    const message = threadMessages[index];
    if (
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      continue;

    const updatedContent = message.content.map((part): typeof part => {
      if (
        part.type !== "tool-call" ||
        part.toolCallId !== toolMessage.tool_call_id
      ) {
        return part;
      }

      return {
        ...part,
        isError: toolMessage.status === "error",
        result: toToolResult(toolMessage),
      };
    });

    threadMessages[index] = { ...message, content: updatedContent };
    return;
  }
}

export function toThreadMessages(
  messages: readonly BaseMessage[],
): ThreadMessageLike[] {
  const threadMessages: ThreadMessageLike[] = [];

  for (const [index, message] of messages.entries()) {
    const fallbackId = `${message.type}-${index}`;
    const messageId = message.id ?? fallbackId;

    if (message.type === "human") {
      threadMessages.push({
        content: toUserThreadContent(message.content),
        id: messageId,
        role: "user",
      });
      continue;
    }

    if (isLangChainToolMessage(message)) {
      attachToolResult(threadMessages, message);
      continue;
    }

    if (message.type !== "ai") {
      continue;
    }

    const content = toAssistantThreadContent(message);
    if (content.length === 0) continue;

    threadMessages.push({
      content,
      id: messageId,
      role: "assistant",
    });
  }

  return threadMessages;
}

export function toLangGraphMessageContent(parts: readonly ContentBlock[]) {
  const content: Array<
    { text: string; type: "text" } | { image_url: string; type: "image_url" }
  > = [];

  for (const part of parts) {
    if (isComposerTextPart(part) && part.text.trim()) {
      content.push({ text: part.text, type: "text" });
      continue;
    }

    if (isComposerImagePart(part) && part.image) {
      content.push({ image_url: part.image, type: "image_url" });
      continue;
    }

    if (
      isComposerFilePart(part) &&
      part.data &&
      part.mimeType?.startsWith("image/")
    ) {
      content.push({ image_url: part.data, type: "image_url" });
      continue;
    }

    if (isComposerFilePart(part) && part.filename) {
      content.push({
        text: `[Attached file: ${part.filename}]`,
        type: "text",
      });
    }
  }

  if (content.length === 0) return null;
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content;
}
