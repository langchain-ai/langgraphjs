import type { BaseMessage } from "@langchain/core/messages";
import { ensureMessageInstances } from "@langchain/langgraph-sdk/ui";

/**
 * Narrow an unknown value to a plain object record.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const snakeToCamel = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/**
 * Recursively convert `snake_case` object keys into `camelCase`.
 *
 * Useful for normalizing payloads produced by Python agents (e.g. HITL
 * interrupt values) so they match the camelCase shapes declared by the
 * LangChain JS types such as `HITLRequest`.
 *
 * Arrays are mapped element-wise; non-plain values (Date, Map, class
 * instances, ...) are returned unchanged.
 */
export const toCamelCaseKeys = <T = unknown>(value: unknown): T => {
  if (Array.isArray(value)) {
    return value.map((item) => toCamelCaseKeys(item)) as unknown as T;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value as T;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, val]) => [snakeToCamel(key), toCamelCaseKeys(val)] as const
  );
  return Object.fromEntries(entries) as T;
};

/**
 * Format arbitrary data for display in debug-oriented panels.
 */
export const safeStringify = (value: unknown) => {
  if (value == null) return "No data yet.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Extract reasoning block text from a protocol message.
 */
export const getReasoningContent = (message: BaseMessage) => {
  if (!Array.isArray(message.content)) return "";

  const reasoning: string[] = [];
  for (const block of message.content) {
    const maybeBlock = block as unknown;
    if (!isRecord(maybeBlock)) continue;
    if (
      maybeBlock["type"] === "reasoning" &&
      typeof maybeBlock["reasoning"] === "string"
    ) {
      reasoning.push(maybeBlock["reasoning"]);
    }
  }

  return reasoning.join("");
};

/**
 * Summarize tool call activity for messages without text content.
 */
export const getToolCallSummary = (message: BaseMessage) => {
  if (!("tool_calls" in message) || !Array.isArray(message.tool_calls)) {
    return "";
  }
  if (message.tool_calls.length === 0) return "";
  return `Requested ${message.tool_calls.length} tool call${message.tool_calls.length === 1 ? "" : "s"
    }.`;
};

/**
 * Derive a short trailing preview for a subagent's latest streamed message.
 */
export const getSubagentPreview = (messages: BaseMessage[] | undefined) => {
  if (!messages || messages.length === 0) return undefined;

  const lastMessage = [...messages].reverse().find((message) => {
    const content =
      message.text ||
      getReasoningContent(message) ||
      getToolCallSummary(message);
    return content.trim().length > 0;
  });

  if (!lastMessage) return undefined;

  const preview =
    lastMessage.text ||
    getReasoningContent(lastMessage) ||
    getToolCallSummary(lastMessage);
  const trimmedPreview = preview.trim();
  if (trimmedPreview.length === 0) return undefined;

  return trimmedPreview.length > 100
    ? `...${trimmedPreview.slice(-100)}`
    : trimmedPreview;
};

/**
 * Convert an unknown messages array into BaseMessage instances.
 */
export const toBaseMessages = (messages: unknown): BaseMessage[] => {
  if (!Array.isArray(messages)) return [];
  return ensureMessageInstances(messages as BaseMessage[]) as BaseMessage[];
};

export const ensureBaseMessages = toBaseMessages;

/**
 * Format a namespace array for compact UI display.
 */
export const formatNamespace = (namespace?: string[]) =>
  namespace != null && namespace.length > 0 ? namespace.join(" / ") : "root";

/**
 * Look up metadata for the most recent assistant message.
 */
export const getLastAssistantMetadata = <TMessage extends BaseMessage>(
  messages: TMessage[],
  getMessagesMetadata?: (message: TMessage) => unknown
) => {
  if (getMessagesMetadata == null) return undefined;
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.type === "ai");
  return lastAssistant != null ? getMessagesMetadata(lastAssistant) : undefined;
};

/**
 * Convert a protocol message type into a UI label.
 */
export const getMessageLabel = (type: BaseMessage["type"]) => {
  switch (type) {
    case "human":
      return "User";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return "Assistant";
  }
};

/**
 * Build a compact badge from stream metadata when available.
 */
export const getMetadataBadge = (metadata: unknown) => {
  if (!isRecord(metadata)) return "";
  const streamMetadata = isRecord(metadata.streamMetadata)
    ? metadata.streamMetadata
    : undefined;
  const node =
    typeof streamMetadata?.langgraph_node === "string"
      ? streamMetadata.langgraph_node
      : undefined;
  const namespace =
    typeof streamMetadata?.langgraph_checkpoint_ns === "string"
      ? streamMetadata.langgraph_checkpoint_ns
      : undefined;

  if (node != null && namespace != null) return `${node} · ${namespace}`;
  if (node != null) return node;
  if (namespace != null) return namespace;
  return "";
};
