import type {
  MessageFinishData,
  UpdatesEvent,
} from "../types.mjs";
import type { MessageState } from "./internal-types.mjs";
import { isRecord } from "./internal-types.mjs";
import {
  getTupleToolCallArgs,
  getTupleToolCallIdentity,
  normalizeFinalToolCallArgs,
  normalizeMessageFinishReason,
} from "./tool-calls.mjs";

const PROTOCOL_STATE_MESSAGE_TYPES = new Set([
  "human",
  "user",
  "ai",
  "assistant",
  "system",
  "tool",
  "function",
  "remove",
]);

/**
 * Creates the initial accumulator for a streamed message.
 *
 * @returns A fresh empty message state.
 */
export const createEmptyMessageState = (): MessageState => ({
  started: false,
  lastText: "",
  finished: false,
  blocks: new Map(),
});

/**
 * Reads the first numeric field present from a list of candidate keys.
 *
 * @param value - Object containing numeric usage metadata.
 * @param keys - Candidate keys to check in order.
 * @returns The first numeric value found.
 */
export const pickNumericField = (
  value: Record<string, unknown>,
  keys: string[]
): number | undefined => {
  for (const key of keys) {
    if (typeof value[key] === "number") {
      return value[key] as number;
    }
  }

  return undefined;
};

/**
 * Normalizes model usage metadata into the protocol usage shape.
 *
 * @param value - Raw usage metadata payload.
 * @returns Normalized usage information when any supported counters exist.
 */
export const toProtocolUsageInfo = (value: unknown) => {
  if (!isRecord(value)) return undefined;

  const inputTokenDetails = isRecord(value.input_token_details)
    ? value.input_token_details
    : undefined;
  const usage = {
    ...(pickNumericField(value, ["inputTokens", "input_tokens"]) != null
      ? {
          inputTokens: pickNumericField(value, [
            "inputTokens",
            "input_tokens",
          ]),
        }
      : {}),
    ...(pickNumericField(value, ["outputTokens", "output_tokens"]) != null
      ? {
          outputTokens: pickNumericField(value, [
            "outputTokens",
            "output_tokens",
          ]),
        }
      : {}),
    ...(pickNumericField(value, ["totalTokens", "total_tokens"]) != null
      ? {
          totalTokens: pickNumericField(value, [
            "totalTokens",
            "total_tokens",
          ]),
        }
      : {}),
    ...(pickNumericField(value, ["cachedTokens", "cached_tokens"]) != null
      ? {
          cachedTokens: pickNumericField(value, [
            "cachedTokens",
            "cached_tokens",
          ]),
        }
      : {}),
    ...(inputTokenDetails != null &&
    pickNumericField(inputTokenDetails, ["cache_read"]) != null
      ? {
          cachedTokens: pickNumericField(inputTokenDetails, ["cache_read"]),
        }
      : {}),
  };

  return Object.keys(usage).length > 0 ? usage : undefined;
};

/**
 * Extracts tuple message finish data from serialized message metadata.
 *
 * @param serialized - Serialized message payload from the source stream.
 * @returns Message finish data when a terminal condition is present.
 */
export const getTupleFinishData = (
  serialized: Record<string, unknown>
):
  | (Pick<MessageFinishData, "reason"> &
      Partial<Pick<MessageFinishData, "usage" | "metadata">>)
  | undefined => {
  const additionalKwargs = isRecord(serialized.additional_kwargs)
    ? serialized.additional_kwargs
    : undefined;
  const responseMetadata = isRecord(serialized.response_metadata)
    ? serialized.response_metadata
    : undefined;
  const usage =
    toProtocolUsageInfo(serialized.usage_metadata) ??
    toProtocolUsageInfo(responseMetadata?.usage);
  const finishReason =
    typeof additionalKwargs?.stop_reason === "string"
      ? additionalKwargs.stop_reason
      : typeof responseMetadata?.stop_reason === "string"
        ? responseMetadata.stop_reason
        : typeof responseMetadata?.finish_reason === "string"
          ? responseMetadata.finish_reason
          : undefined;

  if (finishReason == null && usage == null) return undefined;

  return {
    reason: normalizeMessageFinishReason(finishReason),
    ...(usage != null ? { usage } : {}),
    ...(responseMetadata != null && Object.keys(responseMetadata).length > 0
      ? { metadata: responseMetadata }
      : {}),
  };
};

/**
 * Normalizes protocol message type aliases into LangChain core message types.
 *
 * @param value - Raw message type.
 * @returns The normalized message type, if recognized.
 */
export const normalizeProtocolStateMessageType = (value: unknown) => {
  switch (value) {
    case "assistant":
      return "ai";
    case "user":
      return "human";
    default:
      return typeof value === "string" ? value : undefined;
  }
};

/**
 * Checks whether a value matches the message shape used in state payloads.
 *
 * @param value - Raw state value.
 * @returns Whether the value is a protocol-state message object.
 */
export const isProtocolStateMessage = (
  value: unknown
): value is Record<string, unknown> =>
  isRecord(value) &&
  PROTOCOL_STATE_MESSAGE_TYPES.has(
    normalizeProtocolStateMessageType(value.type) ?? ""
  );

/**
 * Normalizes invalid tool calls embedded in serialized AI messages.
 *
 * @param value - Raw invalid tool call list.
 * @returns Normalized invalid tool calls.
 */
export const normalizeProtocolStateInvalidToolCalls = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  const invalidToolCalls: Record<string, unknown>[] = [];
  for (const rawInvalidToolCall of value) {
    if (!isRecord(rawInvalidToolCall)) continue;

    const identity = getTupleToolCallIdentity(rawInvalidToolCall);
    invalidToolCalls.push({
      ...(identity.id != null ? { id: identity.id } : {}),
      ...(identity.name != null ? { name: identity.name } : {}),
      ...(typeof rawInvalidToolCall.args === "string"
        ? { args: rawInvalidToolCall.args }
        : {}),
      error:
        typeof rawInvalidToolCall.error === "string"
          ? rawInvalidToolCall.error
          : "Malformed args.",
      type: "invalid_tool_call",
    });
  }

  return invalidToolCalls;
};

/**
 * Normalizes tool calls embedded in serialized AI messages.
 *
 * @param value - Raw tool call list.
 * @returns Normalized valid and invalid tool call arrays.
 */
export const normalizeProtocolStateToolCalls = (value: unknown) => {
  if (!Array.isArray(value)) {
    return {
      toolCalls: [] as Record<string, unknown>[],
      invalidToolCalls: [] as Record<string, unknown>[],
    };
  }

  const toolCalls: Record<string, unknown>[] = [];
  const invalidToolCalls: Record<string, unknown>[] = [];

  for (const rawToolCall of value) {
    if (!isRecord(rawToolCall)) continue;

    const identity = getTupleToolCallIdentity(rawToolCall);
    const rawArgs = getTupleToolCallArgs(rawToolCall);
    const normalizedArgs = normalizeFinalToolCallArgs(rawArgs);

    if (identity.name == null) {
      invalidToolCalls.push({
        ...(identity.id != null ? { id: identity.id } : {}),
        ...(typeof rawArgs === "string" ? { args: rawArgs } : {}),
        error: "Incomplete tool call.",
        type: "invalid_tool_call",
      });
      continue;
    }

    if (!normalizedArgs.valid) {
      invalidToolCalls.push({
        ...(identity.id != null ? { id: identity.id } : {}),
        name: identity.name,
        ...(typeof normalizedArgs.args === "string"
          ? { args: normalizedArgs.args }
          : {}),
        error: "Malformed args.",
        type: "invalid_tool_call",
      });
      continue;
    }

    toolCalls.push({
      ...(identity.id != null ? { id: identity.id } : {}),
      name: identity.name,
      args: normalizedArgs.args,
      type: "tool_call",
    });
  }

  return { toolCalls, invalidToolCalls };
};

/**
 * Normalizes a single message embedded in protocol state payloads.
 *
 * @param value - Raw message object.
 * @returns The normalized message shape.
 */
export const normalizeProtocolStateMessage = (
  value: Record<string, unknown>
) => {
  const type = normalizeProtocolStateMessageType(value.type);
  if (type == null) return value;

  const message: Record<string, unknown> = {
    type,
    content: "content" in value ? value.content : "",
  };

  if (typeof value.id === "string") {
    message.id = value.id;
  }
  if (typeof value.name === "string") {
    message.name = value.name;
  }
  if (
    (type === "ai" || type === "human") &&
    typeof value.example === "boolean"
  ) {
    message.example = value.example;
  }

  if (type === "tool") {
    if (typeof value.tool_call_id === "string") {
      message.tool_call_id = value.tool_call_id;
    }
    if (value.status === "success" || value.status === "error") {
      message.status = value.status;
    }
    if ("artifact" in value) {
      message.artifact = value.artifact;
    }
  }

  if (type === "ai") {
    const additionalKwargs = isRecord(value.additional_kwargs)
      ? value.additional_kwargs
      : undefined;
    const rawToolCalls =
      Array.isArray(value.tool_calls) && value.tool_calls.length > 0
        ? value.tool_calls
        : Array.isArray(additionalKwargs?.tool_calls)
          ? additionalKwargs.tool_calls
          : undefined;
    const normalizedToolCalls = normalizeProtocolStateToolCalls(rawToolCalls);
    const normalizedInvalidToolCalls =
      Array.isArray(value.invalid_tool_calls) && value.invalid_tool_calls.length > 0
        ? normalizeProtocolStateInvalidToolCalls(value.invalid_tool_calls)
        : normalizedToolCalls.invalidToolCalls;

    if (normalizedToolCalls.toolCalls.length > 0) {
      message.tool_calls = normalizedToolCalls.toolCalls;
    }
    if (normalizedInvalidToolCalls.length > 0) {
      message.invalid_tool_calls = normalizedInvalidToolCalls;
    }
  }

  return message;
};

/**
 * Recursively normalizes protocol state payloads before they are emitted.
 *
 * @param value - Raw state payload.
 * @returns The normalized state payload.
 */
export const normalizeProtocolStatePayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      isProtocolStateMessage(item)
        ? normalizeProtocolStateMessage(item)
        : normalizeProtocolStatePayload(item)
    );
  }
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "messages" && Array.isArray(entry)) {
      normalized[key] = entry.map((item) =>
        isProtocolStateMessage(item) ? normalizeProtocolStateMessage(item) : item
      );
      continue;
    }

    normalized[key] = normalizeProtocolStatePayload(entry);
  }

  return normalized;
};

/**
 * Coerces arbitrary update payloads into the protocol values shape.
 *
 * @param value - Raw update payload.
 * @returns A valid updates values payload.
 */
export const asUpdateValues = (
  value: unknown
): UpdatesEvent["params"]["data"]["values"] => (isRecord(value) ? value : { value });
