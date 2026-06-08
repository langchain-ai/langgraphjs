/**
 * `@langchain/langgraph/stream` — backend toolkit for the v2 streaming protocol.
 *
 * This entrypoint collects the primitives needed to build a custom transport
 * or server on top of the Agent Streaming Protocol:
 *
 *   - {@link StreamChannel} — an append-only, buffered event log with
 *     independent replay cursors, for buffering events and fanning them out
 *     to multiple subscribers.
 *   - {@link convertToProtocolEvent} — turns raw `streamEvents` (v3) payloads
 *     into canonical {@link ProtocolEvent}s.
 *   - {@link inferChannel} / {@link matchesSubscription} — map an event to its
 *     {@link Channel} and decide whether a buffered event should be delivered
 *     for a given subscription filter (with optional `since` replay cursor).
 *   - {@link SUPPORTED_CHANNELS} / {@link isSupportedChannel} — the recognized
 *     channel set and a guard for validating subscription requests.
 *
 * These are intentionally transport-agnostic: pair them with SSE, WebSocket,
 * or any custom framing to expose a graph over the protocol.
 */

export {
  StreamChannel,
  StreamChannel as EventLog,
  isStreamChannel,
} from "./stream/stream-channel.js";
export {
  convertToProtocolEvent,
  isCheckpointEnvelope,
  STREAM_EVENTS_V3_MODES,
} from "./stream/convert.js";
export type { ConvertToProtocolEventOptions } from "./stream/convert.js";
export {
  inferChannel,
  matchesSubscription,
  isSupportedChannel,
  SUPPORTED_CHANNELS,
  isPrefixMatch,
  normalizeNamespaceSegment,
} from "./stream/subscription.js";
export type { MatchableEvent } from "./stream/subscription.js";
export type {
  Namespace,
  ProtocolEvent,
  ProtocolMethod,
} from "./stream/types.js";
