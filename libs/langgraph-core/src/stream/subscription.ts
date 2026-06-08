/**
 * Subscription matching and channel inference for the v2 streaming protocol.
 *
 * These helpers are the building blocks a custom transport / server needs to
 * fan protocol events out to subscribers: map an event to its logical
 * {@link Channel} ({@link inferChannel}) and decide whether a buffered event
 * should be delivered for a given {@link SubscribeParams} filter
 * ({@link matchesSubscription}). They are typed against the minimal
 * {@link MatchableEvent} shape so the same predicate works on the core
 * {@link ProtocolEvent} produced by {@link convertToProtocolEvent} /
 * {@link StreamChannel} and on the wire-level `Event` from
 * `@langchain/protocol`.
 */

import type { Channel, SubscribeParams } from "@langchain/protocol";
import type { Namespace } from "./types.js";

/**
 * Minimal protocol-event shape consumed by {@link inferChannel} and
 * {@link matchesSubscription}.
 *
 * Both the core {@link ProtocolEvent} and the wire-level `Event` from
 * `@langchain/protocol` structurally satisfy this contract, so the same
 * predicates can drive in-process fan-out, buffered replay, and server-side
 * (SSE / WebSocket) event-sink filtering without coupling to a single event
 * type.
 */
export interface MatchableEvent {
  /** Logical stream channel; see {@link inferChannel}. */
  readonly method: string;

  /** Monotonic sequence number, when present. Used by the `since` cursor. */
  readonly seq?: number;

  readonly params: {
    /** Namespace of the node or scope that emitted this event. */
    readonly namespace: Namespace;

    /** Opaque channel payload; shape depends on `method`. */
    readonly data?: unknown;
  };
}

/**
 * Strip dynamic suffixes (after `:`) from a namespace segment.
 *
 * Server-emitted namespaces contain runtime-generated suffixes like
 * `"fetcher:abc-uuid"`, while user-supplied subscription filters are typically
 * static names (`"fetcher"`). Mirrors `normalize_namespace_segment` in
 * `api/langgraph_api/protocol/namespace.py`.
 *
 * @param segment - Raw namespace segment.
 * @returns The stable graph-oriented portion of the segment.
 */
export function normalizeNamespaceSegment(segment: string): string {
  const idx = segment.indexOf(":");
  return idx === -1 ? segment : segment.slice(0, idx);
}

/**
 * Whether `namespace` starts with `prefix`.
 *
 * Segments are compared literally first; if the prefix segment itself contains
 * no `:`, the candidate segment is also compared after its dynamic suffix is
 * stripped (see {@link normalizeNamespaceSegment}). This mirrors
 * `is_prefix_match` in `api/langgraph_api/protocol/namespace.py` so server-side
 * filtering and client-side per-subscription narrowing stay consistent.
 *
 * @param namespace - Event namespace to test.
 * @param prefix - Subscription namespace prefix.
 */
export function isPrefixMatch(
  namespace: Namespace,
  prefix: Namespace
): boolean {
  if (prefix.length > namespace.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const segment = prefix[i]!;
    const candidate = namespace[i]!;
    if (candidate === segment) continue;
    if (segment.includes(":")) return false;
    if (normalizeNamespaceSegment(candidate) === segment) continue;
    return false;
  }
  return true;
}

function namespaceMatches(
  eventNamespace: Namespace,
  prefixes: Namespace[] | undefined,
  depth: number | undefined
): boolean {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => {
    if (!isPrefixMatch(eventNamespace, prefix)) return false;
    if (depth === undefined) return true;
    return eventNamespace.length - prefix.length <= depth;
  });
}

/**
 * The base protocol subscription channels, excluding the templated
 * `custom:<name>` form. This is the runtime counterpart to the `Channel`
 * union from `@langchain/protocol` and mirrors the channel set a server
 * recognizes when filtering its event sinks.
 */
export const SUPPORTED_CHANNELS = new Set<Channel>([
  "values",
  "updates",
  "messages",
  "tools",
  "lifecycle",
  "input",
  "checkpoints",
  "tasks",
  "custom",
]);

/**
 * Whether `value` names a protocol subscription channel — either a base
 * channel (`"messages"`, `"values"`, …) or a named custom channel
 * (`"custom:<name>"`). Unknown/future method names return `false`,
 * mirroring {@link inferChannel}.
 *
 * @param value - Candidate channel name.
 */
export function isSupportedChannel(value: string): value is Channel {
  return (
    SUPPORTED_CHANNELS.has(value as Channel) || value.startsWith("custom:")
  );
}

/**
 * Maps a protocol event method to its subscription {@link Channel}.
 *
 * Returns `undefined` for unrecognized methods so that new server-side
 * channels (e.g. from extension transformers) don't break existing
 * subscribers. The `custom` method resolves to the named `custom:<name>`
 * channel when the payload carries a `name`, otherwise the bare `custom`
 * channel. Both `"input"` and the wire-level `"input.requested"` map to the
 * `input` channel.
 *
 * @param event - Event whose method should be mapped to a channel.
 */
export function inferChannel(event: MatchableEvent): Channel | undefined {
  switch (event.method) {
    case "values":
      return "values";
    case "checkpoints":
      return "checkpoints";
    case "updates":
      return "updates";
    case "messages":
      return "messages";
    case "tools":
      return "tools";
    case "custom": {
      const data = event.params.data as { name?: string } | undefined;
      return data?.name != null ? `custom:${data.name}` : "custom";
    }
    case "lifecycle":
      return "lifecycle";
    case "input":
    case "input.requested":
      return "input";
    case "tasks":
      return "tasks";
    default:
      return undefined;
  }
}

/**
 * Returns whether an event should be delivered for a subscription definition.
 *
 * When the definition carries a `since` replay cursor, events at or before
 * that sequence number are excluded — letting the same predicate drive both
 * live fan-out and buffered replay over a {@link StreamChannel}.
 *
 * @param event - Event being checked for delivery.
 * @param definition - Subscription filter definition to evaluate against.
 *   The optional `since` field (a `seq` cursor) is read leniently because it
 *   is not a declared field on the base {@link SubscribeParams} shape.
 */
export function matchesSubscription(
  event: MatchableEvent,
  definition: SubscribeParams
): boolean {
  const since = (definition as { since?: unknown }).since;
  if (typeof since === "number" && (event.seq ?? 0) <= since) {
    return false;
  }

  const channel = inferChannel(event);
  if (channel === undefined) return false;

  const channels = definition.channels;
  const channelMatched =
    channels.includes(channel) ||
    (channel.startsWith("custom:") && channels.includes("custom"));
  if (!channelMatched) {
    return false;
  }

  return namespaceMatches(
    event.params.namespace,
    definition.namespaces,
    definition.depth
  );
}
