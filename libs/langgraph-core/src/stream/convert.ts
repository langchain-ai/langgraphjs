/**
 * Protocol event conversion — maps raw `[ns, mode, payload, meta?]` stream
 * chunks from graph.stream() to CDDL-aligned ProtocolEvents.
 */

import type { StreamMode } from "../pregel/types.js";
import type { StreamChunkMeta } from "../pregel/stream.js";
import type {
  Namespace,
  ProtocolEvent,
  ToolsEventData,
  UpdatesEventData,
} from "./types.js";

/**
 * The set of stream modes requested by
 * `streamEvents(..., { version: "v3" })` — every mode the protocol maps
 * to a channel.
 *
 * The verbose `"debug"` mode is intentionally excluded: it was a thin
 * re-wrap of `checkpoints` + `tasks` carrying no new information.
 *
 * The `"checkpoints"` mode is likewise excluded from the stream-mode
 * request because the protocol's `checkpoints` channel carries only a
 * lightweight envelope (`id`, `parent_id`, `step`, `source`) derived from
 * {@link StreamChunkMeta.checkpoint} on the adjacent `values` chunk — not
 * the full-state shape that Pregel's `checkpoints` stream mode produces.
 * `convertToProtocolEvent` emits a companion `checkpoints` protocol event
 * next to each `values` event when meta is present, so clients can build
 * branching/time-travel UIs without a full-state `checkpoints` subscription.
 */
export const STREAM_EVENTS_V3_MODES: StreamMode[] = [
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "tasks",
];

/**
 * Converts a raw `[ns, mode, payload, meta?]` stream chunk emitted by
 * `graph.stream()` into one or more CDDL-aligned {@link ProtocolEvent}s.
 *
 * Most modes produce a single event. `values` chunks carrying
 * {@link StreamChunkMeta.checkpoint} additionally produce a companion
 * `checkpoints` event immediately after the `values` event, so clients
 * that subscribe only to `checkpoints` can build a branching timeline
 * without also paying for full-state `values` payloads, and clients that
 * subscribe to both can correlate the pair by `(namespace, step)` or by
 * adjacent `seq` numbers.
 *
 * Returns an empty array for stream modes that have no protocol mapping.
 *
 * @param options - Conversion inputs for a single raw stream chunk.
 * @param options.namespace - Hierarchical namespace path identifying the
 *   source in the agent tree.
 * @param options.mode - The stream mode that produced this chunk (e.g.
 *   `"messages"`, `"tools"`).
 * @param options.payload - The raw payload emitted by the stream for this
 *   mode.
 * @param options.seq - Monotonically increasing sequence number assigned to
 *   the first returned event; the companion `checkpoints` event (when
 *   emitted) uses `seq + 1`.
 * @param options.meta - Optional chunk-level metadata (e.g. the checkpoint
 *   envelope paired with a `values` chunk).
 * @returns An ordered list of {@link ProtocolEvent}s ready for downstream
 *   reducers. Callers advance their `seq` counter by `result.length`.
 */
export interface ConvertToProtocolEventOptions {
  namespace: Namespace;
  mode: StreamMode;
  payload: unknown;
  seq: number;
  meta?: StreamChunkMeta;
}

function unwrapMessagesPayload(payload: unknown) {
  if (!Array.isArray(payload) || payload.length !== 2) {
    return { data: payload };
  }

  const [data, metadata] = payload;
  if (metadata == null || typeof metadata !== "object") {
    return { data: payload };
  }

  const record = metadata as Record<string, unknown>;
  const node =
    typeof record.langgraph_node === "string"
      ? record.langgraph_node
      : undefined;
  const runId = typeof record.run_id === "string" ? record.run_id : undefined;
  const dataWithRunId =
    runId != null && data != null && typeof data === "object"
      ? { ...(data as Record<string, unknown>), run_id: runId }
      : data;

  return { data: dataWithRunId, node };
}

export function convertToProtocolEvent({
  namespace: ns,
  mode,
  payload,
  seq,
  meta,
}: ConvertToProtocolEventOptions): ProtocolEvent[] {
  const timestamp = Date.now();
  const base = { type: "event" as const };

  switch (mode) {
    case "messages": {
      const { data, node } = unwrapMessagesPayload(payload);
      return [
        {
          ...base,
          seq,
          method: "messages",
          params: { namespace: ns, timestamp, ...(node ? { node } : {}), data },
        },
      ];
    }

    case "tools":
      return [
        {
          ...base,
          seq,
          method: "tools",
          params: {
            namespace: ns,
            timestamp,
            data: convertToolsPayload(payload),
          },
        },
      ];

    case "values": {
      // Emit the `checkpoints` event immediately BEFORE its companion
      // `values` event so clients subscribed to both channels have the
      // envelope buffered by the time the values payload arrives. This
      // lets the SDK attach `parentCheckpointId` to messages extracted
      // from the values snapshot without waiting for a second pass.
      const events: ProtocolEvent[] = [];
      if (meta?.checkpoint != null) {
        events.push({
          ...base,
          seq,
          method: "checkpoints",
          params: { namespace: ns, timestamp, data: meta.checkpoint },
        });
      }
      events.push({
        ...base,
        seq: meta?.checkpoint != null ? seq + 1 : seq,
        method: "values",
        params: { namespace: ns, timestamp, data: payload },
      });
      return events;
    }

    case "updates": {
      const data = convertUpdatesPayload(payload);
      return [
        {
          ...base,
          seq,
          method: "updates",
          params: {
            namespace: ns,
            timestamp,
            // Surface the completed node at the top level of `params` so
            // transformers (notably `LifecycleTransformer`) can attribute
            // a finished task to its child namespace without re-parsing
            // the payload.  The same value is retained inside `data` for
            // downstream consumers that inspect the event body.
            ...(typeof data.node === "string" ? { node: data.node } : {}),
            data,
          },
        },
      ];
    }

    case "custom": {
      const data =
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        "name" in payload
          ? payload
          : { payload };
      return [
        {
          ...base,
          seq,
          method: "custom",
          params: { namespace: ns, timestamp, data },
        },
      ];
    }

    case "tasks":
      return [
        {
          ...base,
          seq,
          method: "tasks",
          params: { namespace: ns, timestamp, data: payload },
        },
      ];

    default:
      return [];
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
      tool_call_id: "",
      message: "Unexpected tools payload shape",
    };
  }

  const p = payload as Record<string, unknown>;
  const tool_call_id = String(p.toolCallId ?? "");

  switch (p.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        tool_call_id,
        tool_name: String(p.name ?? "unknown"),
        input: p.input,
      };

    case "on_tool_event": {
      const delta =
        typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? "");
      return {
        event: "tool-output-delta",
        tool_call_id,
        delta,
      };
    }

    case "on_tool_end":
      return {
        event: "tool-finished",
        tool_call_id,
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
        tool_call_id,
        message: errMessage,
      };
    }

    default:
      return {
        event: "tool-error",
        tool_call_id: "",
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
