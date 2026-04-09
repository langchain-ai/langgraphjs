import type { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

import {
  getMessageLabel,
  getMetadataBadge,
  getReasoningContent,
  getTextContent,
  isRecord,
  safeStringify,
} from "../utils";

type ToolCallWithResult = {
  id: string;
  state: "pending" | "completed" | "error";
  call: {
    name: string;
    args: unknown;
  };
  aiMessage: BaseMessage;
  result?: ToolMessage;
};

interface MessageFeedProps {
  messages: BaseMessage[];
  getMessageMetadata?: (message: BaseMessage) => unknown;
}
const isToolMessage = (message: BaseMessage): message is ToolMessage =>
  message.type === "tool" && "tool_call_id" in message;

const isAiMessageWithToolCalls = (
  message: BaseMessage,
): message is AIMessage & {
  tool_calls?: Array<{
    id?: string;
    name: string;
    args: unknown;
  }>;
} => message.type === "ai" && "tool_calls" in message;

const getToolCallsWithResults = (messages: BaseMessage[]): ToolCallWithResult[] => {
  const toolResultsById = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (isToolMessage(message) && typeof message.tool_call_id === "string") {
      toolResultsById.set(message.tool_call_id, message);
    }
  }

  const toolCalls: ToolCallWithResult[] = [];
  for (const message of messages) {
    if (!isAiMessageWithToolCalls(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const call of message.tool_calls) {
      if (call == null || typeof call.name !== "string") {
        continue;
      }

      const result =
        typeof call.id === "string" ? toolResultsById.get(call.id) : undefined;
      const status = result?.status === "error" ? "error" : result ? "completed" : "pending";

      toolCalls.push({
        id: call.id ?? `${message.id ?? "message"}:${call.name}:${toolCalls.length}`,
        state: status,
        call: {
          name: call.name,
          args: call.args,
        },
        aiMessage: message,
        result,
      });
    }
  }

  return toolCalls;
};


const TOOL_PREVIEW_LIMIT = 220;
const TOOL_CODE_PREVIEW_LINES = 8;
const MESSAGE_CONTENT_TOKEN_LIMIT = 120;
const MESSAGE_CONTENT_CHAR_LIMIT = 800;

const truncateText = (value: string, maxLength = TOOL_PREVIEW_LIMIT) => {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const getTokenLimitedPreview = (
  value: string,
  maxTokens = MESSAGE_CONTENT_TOKEN_LIMIT,
  maxChars = MESSAGE_CONTENT_CHAR_LIMIT
) => {
  const normalized = value.trim();
  const parts = normalized.split(/(\s+)/);
  let tokenCount = 0;
  let endIndex = parts.length;

  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.trim().length === 0) {
      continue;
    }

    tokenCount += 1;
    if (tokenCount > maxTokens) {
      endIndex = index;
      break;
    }
  }

  const tokenPreview = parts.slice(0, endIndex).join("").trimEnd();
  const isTokenTruncated = endIndex < parts.length;
  const isCharTruncated = normalized.length > maxChars;
  const charPreview = isCharTruncated
    ? `${normalized.slice(0, maxChars - 3).trimEnd()}...`
    : normalized;

  if (isTokenTruncated && isCharTruncated) {
    return tokenPreview.length <= charPreview.length
      ? {
          preview: `${tokenPreview}...`,
          isTruncated: true,
        }
      : {
          preview: charPreview,
          isTruncated: true,
        };
  }

  if (isTokenTruncated) {
    return {
      preview: `${tokenPreview}...`,
      isTruncated: true,
    };
  }

  return {
    preview: charPreview,
    isTruncated: isCharTruncated,
  };
};

const formatToolName = (name: string) =>
  name
    .split(/[_-]/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");

const parseToolPayload = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const pickFirstString = (
  record: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const getCustomerLabel = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  if (typeof value.customerName === "string" && value.customerName.trim().length > 0) {
    return value.customerName.trim();
  }

  const firstName =
    typeof value.firstName === "string" ? value.firstName.trim() : "";
  const lastName =
    typeof value.lastName === "string" ? value.lastName.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return fullName.length > 0 ? fullName : undefined;
};

const getToolTheme = (name: string) => {
  if (name === "task") return "theme-task";
  if (name === "js_eval") return "theme-code";
  if (name.startsWith("validate_poem_")) return "theme-validator";
  return "theme-generic";
};

const getToolTitle = (name: string) => {
  if (name === "task") return "Subagent Task";
  if (name === "js_eval") return "QuickJS Eval";
  if (name.startsWith("validate_poem_")) {
    return `${formatToolName(name.replace("validate_", ""))} Validator`;
  }

  return formatToolName(name);
};

const getToolTagValues = (name: string, args: unknown, result: unknown) => {
  const tags: string[] = [];
  const parsedArgs = parseToolPayload(args);
  const parsedResult = parseToolPayload(result);
  const customerLabel = getCustomerLabel(parsedArgs) ?? getCustomerLabel(parsedResult);

  if (name === "task" && isRecord(parsedArgs)) {
    const subagentType = pickFirstString(parsedArgs, [
      "subagent_type",
      "subagentType",
      "agent",
      "worker",
    ]);
    if (subagentType != null) tags.push(subagentType);
  }

  if (customerLabel != null) {
    tags.push(customerLabel);
  }

  if (name === "js_eval" && isRecord(parsedArgs)) {
    const code = pickFirstString(parsedArgs, ["code", "javascript", "script"]);
    if (code != null) {
      tags.push(`${code.split("\n").length} line${code.includes("\n") ? "s" : ""}`);
    }
  }

  const validatorAttempt =
    isRecord(parsedArgs) && typeof parsedArgs.attempt === "number"
      ? parsedArgs.attempt
      : isRecord(parsedResult) && typeof parsedResult.attempt === "number"
        ? parsedResult.attempt
        : undefined;
  if (validatorAttempt != null) {
    tags.push(`Attempt ${validatorAttempt + 1}`);
  }

  return tags.slice(0, 3);
};

const getToolInputPreview = (name: string, args: unknown) => {
  const parsedArgs = parseToolPayload(args);
  if (!isRecord(parsedArgs)) {
    return typeof parsedArgs === "string"
      ? { label: "Input", value: truncateText(parsedArgs), isCode: false }
      : undefined;
  }

  if (name === "js_eval") {
    const code = pickFirstString(parsedArgs, ["code", "javascript", "script"]);
    if (code != null) {
      return {
        label: "Code",
        value: code.split("\n").slice(0, TOOL_CODE_PREVIEW_LINES).join("\n"),
        isCode: true,
      };
    }
  }

  if (name === "task") {
    const prompt = pickFirstString(parsedArgs, [
      "description",
      "prompt",
      "task",
      "instructions",
      "input",
    ]);
    if (prompt != null) {
      return { label: "Task", value: truncateText(prompt), isCode: false };
    }
  }

  if (name.startsWith("validate_poem_")) {
    const poem = pickFirstString(parsedArgs, ["poem"]);
    if (poem != null) {
      return { label: "Draft", value: truncateText(poem), isCode: false };
    }
  }

  const summary = pickFirstString(parsedArgs, [
    "description",
    "prompt",
    "input",
    "query",
    "title",
    "location",
    "topic",
    "expression",
  ]);
  if (summary != null) {
    return { label: "Input", value: truncateText(summary), isCode: false };
  }

  return {
    label: "Input",
    value: truncateText(safeStringify(parsedArgs)),
    isCode: false,
  };
};

const getToolResultPreview = (name: string, result: ToolCallWithResult["result"]) => {
  if (result == null) return undefined;

  const parsedContent = parseToolPayload(result.content);
  if (name.startsWith("validate_poem_") && isRecord(parsedContent)) {
    const feedback =
      typeof parsedContent.feedback === "string"
        ? parsedContent.feedback
        : undefined;
    const passed =
      typeof parsedContent.passed === "boolean" ? parsedContent.passed : undefined;
    if (feedback != null) {
      return {
        label: passed ? "Passed" : result.status === "error" ? "Error" : "Feedback",
        value: truncateText(feedback),
      };
    }
  }

  if (isRecord(parsedContent)) {
    const preview = pickFirstString(parsedContent, [
      "summary",
      "message",
      "result",
      "output",
      "content",
      "feedback",
      "answer",
    ]);
    if (preview != null) {
      return {
        label: result.status === "error" ? "Error" : "Result",
        value: truncateText(preview),
      };
    }
  }

  if (typeof parsedContent === "string" && parsedContent.trim().length > 0) {
    return {
      label: result.status === "error" ? "Error" : "Result",
      value: truncateText(parsedContent),
    };
  }

  return {
    label: result.status === "error" ? "Error" : "Result",
    value: truncateText(safeStringify(parsedContent)),
  };
};

function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult;
}) {
  const inputPreview = getToolInputPreview(toolCall.call.name, toolCall.call.args);
  const resultPreview = getToolResultPreview(toolCall.call.name, toolCall.result);
  const tags = getToolTagValues(
    toolCall.call.name,
    toolCall.call.args,
    toolCall.result?.content
  );

  return (
    <section className={`tool-card tool-card-${getToolTheme(toolCall.call.name)}`}>
      <div className="tool-card-header">
        <div>
          <div className="tool-card-title">{getToolTitle(toolCall.call.name)}</div>
          <div className="tool-card-name">{toolCall.call.name}</div>
        </div>
        <span className={`status-pill status-${toolCall.state}`}>
          {toolCall.state}
        </span>
      </div>

      {tags.length > 0 ? (
        <div className="tool-card-tags">
          {tags.map((tag) => (
            <span key={tag} className="tool-card-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {inputPreview != null ? (
        <div className="tool-card-section">
          <div className="tool-card-section-label">{inputPreview.label}</div>
          {inputPreview.isCode ? (
            <pre className="tool-card-code">{inputPreview.value}</pre>
          ) : (
            <div className="tool-card-copy">{inputPreview.value}</div>
          )}
        </div>
      ) : null}

      {resultPreview != null ? (
        <div className="tool-card-section">
          <div className="tool-card-section-label">{resultPreview.label}</div>
          <div className="tool-card-copy">{resultPreview.value}</div>
        </div>
      ) : null}
    </section>
  );
}

export function MessageFeed({
  messages,
  getMessageMetadata,
}: MessageFeedProps) {
  const allToolCalls = getToolCallsWithResults(messages);
  const pairedToolResultIds = new Set(
    allToolCalls
      .map((toolCall) => toolCall.result?.tool_call_id)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === "string"),
  );
  const toolCallsByMessage = new Map<
    BaseMessage,
    ToolCallWithResult[]
  >();

  for (const toolCall of allToolCalls) {
    const existing =
      toolCallsByMessage.get(toolCall.aiMessage as BaseMessage) ?? [];
    existing.push(toolCall);
    toolCallsByMessage.set(
      toolCall.aiMessage as BaseMessage,
      existing as ToolCallWithResult[]
    );
  }

  if (messages.length === 0) {
    return (
      <div className="empty-feed">
        <h3>No messages yet</h3>
        <p>
          Start a run to inspect how this agent behaves over the new protocol.
        </p>
      </div>
    );
  }

  return (
    <div className="message-feed">
      {messages.map((message, index) => {
        if (isToolMessage(message) && pairedToolResultIds.has(message.tool_call_id)) {
          return null;
        }

        const text = getTextContent(message);
        const reasoning = getReasoningContent(message);
        const metadata = getMessageMetadata?.(message);
        const badge = getMetadataBadge(metadata);
        const toolCalls = toolCallsByMessage.get(message) ?? [];
        const content =
          text ||
          reasoning ||
          (toolCalls.length === 0 ? safeStringify(message.content) : "");
        const contentPreview = getTokenLimitedPreview(content);

        return (
          <article
            key={message.id ?? `${message.type}-${index}`}
            className="message-card"
          >
            <div className="message-card-header">
              <span className="message-role">
                {getMessageLabel(message.type)}
              </span>
              {badge ? <span className="message-badge">{badge}</span> : null}
            </div>
            {reasoning ? (
              <div className="reasoning-block">
                <div className="reasoning-label">Reasoning</div>
                <div>{reasoning}</div>
              </div>
            ) : null}
            {content.trim().length > 0 ? (
              contentPreview.isTruncated ? (
                <div className="message-content-stack">
                  <div className="message-content">{contentPreview.preview}</div>
                  <details className="message-content-details">
                    <summary>Show full message</summary>
                    <div className="message-content message-content-expanded">
                      {content}
                    </div>
                  </details>
                </div>
              ) : (
                <div className="message-content">{content}</div>
              )
            ) : null}
            {toolCalls.length > 0 ? (
              <div className="tool-card-list">
                {toolCalls.map((toolCall) => (
                  <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
