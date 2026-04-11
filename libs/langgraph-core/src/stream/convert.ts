/**
 * Protocol event conversion — maps raw `[ns, mode, payload]` stream chunks
 * from graph.stream() to CDDL-aligned ProtocolEvents.
 */

import type { StreamMode } from "../pregel/types.js";
import type {
  Namespace,
  ProtocolEvent,
  ToolsEventData,
  UpdatesEventData,
} from "./types.js";

/**
 * The complete set of stream modes requested by `streamV2()`, ensuring every
 * protocol-defined channel is captured.
 */
export const STREAM_V2_MODES: StreamMode[] = [
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "debug",
  "checkpoints",
  "tasks",
];

/**
 * Converts a raw `[ns, mode, payload]` stream chunk emitted by
 * `graph.stream()` into a CDDL-aligned {@link ProtocolEvent}.
 *
 * Returns `null` for stream modes that have no protocol mapping.
 *
 * @param ns - Hierarchical namespace path identifying the source in the
 *   agent tree.
 * @param mode - The stream mode that produced this chunk (e.g. `"messages"`,
 *   `"tools"`).
 * @param payload - The raw payload emitted by the stream for this mode.
 * @param seq - Monotonically increasing sequence number for ordering.
 * @returns A {@link ProtocolEvent} ready for downstream reducers, or `null`
 *   if the mode is unrecognised.
 */
export function convertToProtocolEvent(
  ns: Namespace,
  mode: StreamMode,
  payload: unknown,
  seq: number
): ProtocolEvent | null {
  const timestamp = Date.now();
  const base = { type: "event" as const, seq };

  switch (mode) {
    case "messages":
      return {
        ...base,
        method: "messages",
        params: { namespace: ns, timestamp, data: payload },
      };

    case "tools":
      return {
        ...base,
        method: "tools",
        params: {
          namespace: ns,
          timestamp,
          data: convertToolsPayload(payload),
        },
      };

    case "values":
      return {
        ...base,
        method: "values",
        params: { namespace: ns, timestamp, data: payload },
      };

    case "updates":
      return {
        ...base,
        method: "updates",
        params: {
          namespace: ns,
          timestamp,
          data: convertUpdatesPayload(payload),
        },
      };

    case "custom":
      return {
        ...base,
        method: "custom",
        params: { namespace: ns, timestamp, data: { payload } },
      };

    case "debug":
      return {
        ...base,
        method: "debug",
        params: { namespace: ns, timestamp, data: payload },
      };

    case "checkpoints":
      return {
        ...base,
        method: "checkpoints",
        params: { namespace: ns, timestamp, data: payload },
      };

    case "tasks":
      return {
        ...base,
        method: "tasks",
        params: { namespace: ns, timestamp, data: payload },
      };

    default:
      return null;
  }
}

/**
 * Normalises a raw tools-mode payload into a typed {@link ToolsEventData}
 * discriminated union, mapping internal lifecycle events (`on_tool_start`,
 * `on_tool_end`, etc.) to their protocol counterparts.
 *
 * @param payload - The raw payload from a `"tools"` stream chunk.
 * @returns A {@link ToolsEventData} object with the appropriate `event`
 *   discriminant and associated fields.
 */
function convertToolsPayload(payload: unknown): ToolsEventData {
  if (typeof payload !== "object" || payload === null) {
    return {
      event: "tool-error",
      toolCallId: "",
      message: "Unexpected tools payload shape",
    };
  }

  const p = payload as Record<string, unknown>;
  const toolCallId = String(p.toolCallId ?? "");

  switch (p.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        toolCallId,
        toolName: String(p.name ?? "unknown"),
        input: p.input,
      };

    case "on_tool_event": {
      const delta =
        typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? "");
      return {
        event: "tool-output-delta",
        toolCallId,
        delta,
      };
    }

    case "on_tool_end":
      return {
        event: "tool-finished",
        toolCallId,
        output: p.output,
      };

    case "on_tool_error": {
      const err = p.error;
      const errMessage =
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : String(err ?? "unknown error");
      return {
        event: "tool-error",
        toolCallId,
        message: errMessage,
      };
    }

    default:
      return {
        event: "tool-error",
        toolCallId: "",
        message: `Unknown tool event: ${String(p.event)}`,
      };
  }
}

/**
 * Extracts the first `{node: delta}` entry from an updates-mode payload and
 * reshapes it into an {@link UpdatesEventData} with explicit `node` and
 * `values` fields.  Non-object payloads are coerced to `{ values: {} }`.
 *
 * @param payload - The raw payload from an `"updates"` stream chunk,
 *   expected to be a `Record<string, unknown>` keyed by node name.
 * @returns An {@link UpdatesEventData} containing the extracted node name
 *   and its associated delta values.
 */
function convertUpdatesPayload(payload: unknown): UpdatesEventData {
  if (typeof payload !== "object" || payload === null) {
    return { values: {} };
  }

  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) {
    return { values: {} };
  }

  const [node, values] = entries[0];
  return {
    node,
    values: (typeof values === "object" && values !== null
      ? values
      : { value: values }) as Record<string, unknown>,
  };
}
