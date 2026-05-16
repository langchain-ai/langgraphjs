import type {
  Channel,
  Event,
  Namespace,
  SubscribeParams,
} from "@langchain/protocol";

/**
 * Strip dynamic suffixes (after `:`) from a namespace segment.
 *
 * Mirrors `normalize_namespace_segment` in
 * `api/langgraph_api/protocol/namespace.py`. Server-emitted namespaces
 * contain runtime-generated suffixes like `"fetcher:abc-uuid"`, while
 * user-supplied filters are typically static names (`"fetcher"`).
 */
function normalizeSegment(segment: string): string {
  const idx = segment.indexOf(":");
  return idx === -1 ? segment : segment.slice(0, idx);
}

/**
 * Whether `eventNamespace` starts with `prefix`.
 *
 * Segments are compared literally first; if the prefix segment itself
 * contains no `:`, the candidate segment is also compared after its
 * dynamic suffix is stripped. This mirrors `is_prefix_match` in
 * `api/langgraph_api/protocol/namespace.py` so server-side filtering
 * and client-side per-subscription narrowing stay consistent.
 */
function isPrefixMatch(eventNamespace: Namespace, prefix: Namespace): boolean {
  if (prefix.length > eventNamespace.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const segment = prefix[i]!;
    const candidate = eventNamespace[i]!;
    if (candidate === segment) continue;
    if (segment.includes(":")) return false;
    if (normalizeSegment(candidate) === segment) continue;
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
 * Maps a protocol event method to its subscription channel.
 *
 * Returns `undefined` for unrecognized methods so that new server-side
 * channels (e.g. from extension transformers) don't break existing clients.
 *
 * @param event - Event whose method should be mapped to a channel.
 */
export function inferChannel(event: Event): Channel | undefined {
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
 * @param event - Event being checked for delivery.
 * @param definition - Subscription filter definition to evaluate against.
 */
export function matchesSubscription(
  event: Event,
  definition: SubscribeParams
): boolean {
  const channel = inferChannel(event);
  if (channel === undefined) return false;

  const channels = definition.channels as Channel[];
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
