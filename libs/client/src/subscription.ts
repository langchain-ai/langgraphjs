import type {
  Channel,
  Event,
  MediaType,
  Namespace,
  SubscribeParams,
} from "@langchain/protocol";

/**
 * Returns whether an event namespace matches one of the requested prefixes and
 * optional depth constraint.
 *
 * @param eventNamespace - Namespace attached to the incoming event.
 * @param prefixes - Namespace prefixes requested by the subscription.
 * @param depth - Maximum namespace depth beyond a matching prefix.
 */
function namespaceMatches(
  eventNamespace: Namespace,
  prefixes: Namespace[] | undefined,
  depth: number | undefined
): boolean {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => {
    if (prefix.length > eventNamespace.length) {
      return false;
    }

    for (let index = 0; index < prefix.length; index += 1) {
      if (prefix[index] !== eventNamespace[index]) {
        return false;
      }
    }

    if (depth === undefined) {
      return true;
    }

    return eventNamespace.length - prefix.length <= depth;
  });
}

/**
 * Applies media-type filtering for media events while allowing all other event
 * families to pass through unchanged.
 *
 * @param event - Event being evaluated against subscription filters.
 * @param mediaTypes - Allowed media types declared by the subscription.
 */
function mediaTypeMatches(
  event: Event,
  mediaTypes: MediaType[] | undefined
): boolean {
  if (!mediaTypes || mediaTypes.length === 0) {
    return true;
  }

  if (
    event.method === "media.streamStart" ||
    event.method === "media.artifact"
  ) {
    return mediaTypes.includes(event.params.mediaType);
  }

  return true;
}

/**
 * Maps a protocol event method to its subscription channel.
 *
 * @param event - Event whose method should be mapped to a channel.
 */
export function inferChannel(event: Event): Channel {
  switch (event.method) {
    case "values":
      return "values";
    case "updates":
      return "updates";
    case "messages":
      return "messages";
    case "tools":
      return "tools";
    case "custom":
      return "custom";
    case "lifecycle":
      return "lifecycle";
    case "media.streamStart":
    case "media.streamEnd":
    case "media.artifact":
      return "media";
    case "resource.changed":
      return "resource";
    case "sandbox.started":
    case "sandbox.output":
    case "sandbox.exited":
      return "sandbox";
    case "input.requested":
      return "input";
    case "state.updated":
    case "state.storeChanged":
      return "state";
    case "usage.llmCall":
    case "usage.summary":
      return "usage";
    case "debug":
      return "debug";
    case "checkpoints":
      return "checkpoints";
    case "tasks":
      return "tasks";
    default:
      throw new Error(
        `Unknown event method: ${String((event as { method?: string }).method)}`
      );
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
  if (!definition.channels.includes(channel)) {
    return false;
  }

  if (
    !namespaceMatches(
      event.params.namespace,
      definition.namespaces,
      definition.depth
    )
  ) {
    return false;
  }

  return mediaTypeMatches(event, definition.mediaTypes);
}
