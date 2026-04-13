import type { Run } from "../../storage/types.mjs";
import type {
  DebugEvent,
  ProtocolEventDataByMethod,
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
} from "../types.mjs";
import type { NormalizedUpdatesData } from "./internal-types.mjs";
import { isRecord } from "./internal-types.mjs";
import { asUpdateValues } from "./state-normalizers.mjs";

/**
 * Stringifies values without throwing on circular structures.
 *
 * @param value - Value to stringify.
 * @returns A safe string representation.
 */
export const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Extracts a readable error message from arbitrary payloads.
 *
 * @param value - Error-like payload.
 * @returns A human-readable error string.
 */
export const extractErrorMessage = (value: unknown) => {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string")
    return value.message;
  return safeStringify(value);
};

/**
 * Extracts text content from a legacy streamed message payload.
 *
 * @param value - Message content in string or block-array form.
 * @returns Concatenated text content when available.
 */
export const extractTextContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return undefined;
      })
      .filter((part): part is string => part != null);
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
};

/**
 * Converts a persisted run status into a protocol lifecycle status.
 *
 * @param status - Run status from storage.
 * @returns The corresponding protocol agent status.
 */
export const toLifecycleStatus = (status: Run["status"]) => {
  if (status === "success") return "completed";
  if (status === "error") return "failed";
  if (status === "interrupted") return "interrupted";
  return "running";
};

/**
 * Normalizes raw updates payloads into the protocol updates shape.
 *
 * @param value - Raw updates payload.
 * @returns The optional node plus normalized values object.
 */
export const normalizeUpdatesData = (value: unknown): NormalizedUpdatesData => {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [node, nodeValues] = entries[0];
      return { node, values: asUpdateValues(nodeValues) };
    }
  }
  return { values: asUpdateValues(value) };
};

const asInterruptArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.__interrupt__)) {
    return value.__interrupt__;
  }
  return [];
};

export const normalizeInputRequestedData = (
  value: unknown
): ProtocolEventDataByMethod<"input">[] =>
  asInterruptArray(value).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return [];
    }
    return [
      {
        interruptId: entry.id,
        payload: "value" in entry ? entry.value : undefined,
      } satisfies ProtocolEventDataByMethod<"input">,
    ];
  });

export const stripInterruptsFromValues = (value: unknown) => {
  const inputRequests = normalizeInputRequestedData(value);
  if (!isRecord(value) || !("__interrupt__" in value)) {
    return {
      inputRequests,
      values: value,
    };
  }

  const { __interrupt__, ...rest } = value;
  void __interrupt__;
  return {
    inputRequests,
    values: rest,
  };
};

/**
 * Resolves the tool call identifier for a tool event payload.
 *
 * @param value - Raw tool event payload.
 * @param fallbackToolCallId - Generated fallback identifier.
 * @returns The resolved tool call identifier.
 */
export const getToolCallId = (
  value: Record<string, unknown>,
  fallbackToolCallId: string
): string => {
  if (typeof value.toolCallId === "string") return value.toolCallId;
  if (typeof value.tool_call_id === "string") return value.tool_call_id;
  if (typeof value.id === "string") return value.id;
  return fallbackToolCallId;
};

/**
 * Normalizes raw tool stream events into protocol tool events.
 *
 * @param value - Raw tool event payload.
 * @param fallbackToolCallId - Generated fallback identifier.
 * @returns A normalized protocol tool event payload.
 */
export const normalizeToolData = (
  value: unknown,
  fallbackToolCallId: string
): ToolsData => {
  if (!isRecord(value) || typeof value.event !== "string") {
    return {
      event: "tool-output-delta",
      toolCallId: fallbackToolCallId,
      delta: extractErrorMessage(value),
    } satisfies ToolOutputDeltaData;
  }

  const toolCallId = getToolCallId(value, fallbackToolCallId);

  switch (value.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        toolCallId,
        toolName: typeof value.name === "string" ? value.name : "tool",
        input: value.input,
      } satisfies ToolStartedData;
    case "on_tool_event":
      return {
        event: "tool-output-delta",
        toolCallId,
        delta:
          typeof value.data === "string"
            ? value.data
            : safeStringify(value.data ?? null),
      } satisfies ToolOutputDeltaData;
    case "on_tool_end":
      return {
        event: "tool-finished",
        toolCallId,
        output: value.output,
      } satisfies ToolFinishedData;
    case "on_tool_error":
      return {
        event: "tool-error",
        toolCallId,
        message: extractErrorMessage(value.error),
      } satisfies ToolErrorData;
    default:
      return {
        event: "tool-output-delta",
        toolCallId,
        delta: safeStringify(value),
      } satisfies ToolOutputDeltaData;
  }
};

/**
 * Checks whether a debug payload type is supported by the protocol.
 *
 * @param value - Raw debug payload type.
 * @returns Whether the type is one of the protocol debug variants.
 */
export const isDebugChunkType = (
  value: unknown
): value is DebugEvent["params"]["data"]["type"] =>
  value === "checkpoint" || value === "task" || value === "task_result";

/**
 * Normalizes raw debug payloads into protocol debug events.
 *
 * @param value - Raw debug payload.
 * @returns A normalized protocol debug payload.
 */
export const normalizeDebugData = (
  value: unknown
): DebugEvent["params"]["data"] => {
  if (
    isRecord(value) &&
    typeof value.step === "number" &&
    isDebugChunkType(value.type)
  ) {
    return {
      step: value.step,
      type: value.type,
      payload: value.payload,
    };
  }
  return {
    step: -1,
    type: "task",
    payload: value,
  };
};
