import type { MessageBlockState } from "./internal-types.mjs";
import { isRecord } from "./internal-types.mjs";

/**
 * Checks whether a tuple payload contains a serialized message plus metadata.
 *
 * @param value - Raw event payload.
 * @returns Whether the payload matches the tuple message format.
 */
export const isMessageTuplePayload = (
  value: unknown
): value is [Record<string, unknown>, unknown] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isRecord(value[0]) &&
  typeof value[0].type === "string";

/**
 * Reads a tool call index from a serialized chunk, falling back to position.
 *
 * @param value - Serialized tool call chunk or tool call.
 * @param fallback - Index derived from the current array offset.
 * @returns The resolved tool call index.
 */
export const getTupleToolCallIndex = (
  value: Record<string, unknown>,
  fallback: number
) => (typeof value.index === "number" ? value.index : fallback);

/**
 * Extracts the stable identity fields for a tuple tool call.
 *
 * @param value - Serialized tool call payload.
 * @returns The resolved identifier and function name, when present.
 */
export const getTupleToolCallIdentity = (value: Record<string, unknown>) => {
  const nestedFunction = isRecord(value.function) ? value.function : undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name:
      typeof value.name === "string"
        ? value.name
        : typeof nestedFunction?.name === "string"
          ? nestedFunction.name
          : undefined,
  };
};

/**
 * Extracts the raw argument payload for a tuple tool call.
 *
 * @param value - Serialized tool call payload.
 * @returns The raw arguments field, if present.
 */
export const getTupleToolCallArgs = (value: Record<string, unknown>) => {
  if ("args" in value) return value.args;

  const nestedFunction = isRecord(value.function) ? value.function : undefined;
  return nestedFunction?.arguments;
};

/**
 * Parses the final argument payload for a completed tool call.
 *
 * @param value - Raw tool call arguments.
 * @returns The parsed arguments plus a validity flag.
 */
export const normalizeFinalToolCallArgs = (value: unknown) => {
  if (isRecord(value)) {
    return { valid: true, args: value as unknown };
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return { valid: true, args: {} };
    }

    try {
      return {
        valid: true,
        args: JSON.parse(value) as unknown,
      };
    } catch {
      return { valid: false, args: value };
    }
  }

  if (value == null) {
    return { valid: true, args: {} };
  }

  return { valid: true, args: value };
};

/**
 * Finalizes a streamed tool call block into a terminal protocol content block.
 *
 * @param block - Accumulated streamed tool call block state.
 * @param rawToolCalls - Completed tool calls from the serialized message.
 * @param rawInvalidToolCalls - Invalid tool calls from the serialized message.
 * @param index - Content block index being finalized.
 * @returns A finalized tool call or invalid tool call content block.
 */
export const finalizeTupleToolCall = (
  block: MessageBlockState,
  rawToolCalls: unknown,
  rawInvalidToolCalls: unknown,
  index: number
):
  | {
      type: "tool_call";
      id: string | null;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "invalid_tool_call";
      id: string | null;
      name: string | null;
      args: string | null;
      error: string;
    } => {
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
  const invalidToolCalls = Array.isArray(rawInvalidToolCalls)
    ? rawInvalidToolCalls
    : [];

  for (let offset = 0; offset < invalidToolCalls.length; offset += 1) {
    const rawInvalid = invalidToolCalls[offset];
    if (!isRecord(rawInvalid)) continue;
    if (getTupleToolCallIndex(rawInvalid, offset) !== index) continue;

    const identity = getTupleToolCallIdentity(rawInvalid);
    return {
      type: "invalid_tool_call",
      id: identity.id ?? null,
      name: identity.name ?? null,
      args: typeof rawInvalid.args === "string" ? rawInvalid.args : null,
      error:
        typeof rawInvalid.error === "string"
          ? rawInvalid.error
          : "Malformed args.",
    };
  }

  for (let offset = 0; offset < toolCalls.length; offset += 1) {
    const rawToolCall = toolCalls[offset];
    if (!isRecord(rawToolCall)) continue;
    if (getTupleToolCallIndex(rawToolCall, offset) !== index) continue;

    const identity = getTupleToolCallIdentity(rawToolCall);
    const normalizedArgs = normalizeFinalToolCallArgs(
      getTupleToolCallArgs(rawToolCall)
    );
    if (identity.id == null || identity.name == null) {
      return {
        type: "invalid_tool_call",
        id: identity.id ?? null,
        name: identity.name ?? null,
        args: block.value,
        error: "Incomplete tool call.",
      };
    }
    if (!normalizedArgs.valid) {
      return {
        type: "invalid_tool_call",
        id: identity.id,
        name: identity.name,
        args:
          typeof normalizedArgs.args === "string"
            ? normalizedArgs.args
            : block.value,
        error: "Malformed args.",
      };
    }

    return {
      type: "tool_call",
      id: identity.id,
      name: identity.name,
      args: isRecord(normalizedArgs.args) ? normalizedArgs.args : {},
    };
  }

  if (block.id == null || block.name == null) {
    return {
      type: "invalid_tool_call",
      id: block.id ?? null,
      name: block.name ?? null,
      args: block.value,
      error: "Incomplete tool call.",
    };
  }

  if (block.value === "") {
    return {
      type: "tool_call",
      id: block.id,
      name: block.name,
      args: {},
    };
  }

  try {
    const parsed: unknown = JSON.parse(block.value);
    return {
      type: "tool_call",
      id: block.id,
      name: block.name,
      args: isRecord(parsed) ? parsed : {},
    };
  } catch {
    return {
      type: "invalid_tool_call",
      id: block.id ?? null,
      name: block.name,
      args: block.value,
      error: "Malformed args.",
    };
  }
};

