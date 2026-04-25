import type { Run } from "../../storage/types.mjs";
import type {
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
        interrupt_id: entry.id,
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
      tool_call_id: fallbackToolCallId,
      delta: extractErrorMessage(value),
    } satisfies ToolOutputDeltaData;
  }

  const toolCallId = getToolCallId(value, fallbackToolCallId);

  switch (value.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        tool_call_id: toolCallId,
        tool_name: typeof value.name === "string" ? value.name : "tool",
        input: value.input,
      } satisfies ToolStartedData;
    case "on_tool_event":
      return {
        event: "tool-output-delta",
        tool_call_id: toolCallId,
        delta:
          typeof value.data === "string"
            ? value.data
            : safeStringify(value.data ?? null),
      } satisfies ToolOutputDeltaData;
    case "on_tool_end":
      return {
        event: "tool-finished",
        tool_call_id: toolCallId,
        output: value.output,
      } satisfies ToolFinishedData;
    case "on_tool_error":
      return {
        event: "tool-error",
        tool_call_id: toolCallId,
        message: extractErrorMessage(value.error),
      } satisfies ToolErrorData;
    default:
      return {
        event: "tool-output-delta",
        tool_call_id: toolCallId,
        delta: safeStringify(value),
      } satisfies ToolOutputDeltaData;
  }
};
