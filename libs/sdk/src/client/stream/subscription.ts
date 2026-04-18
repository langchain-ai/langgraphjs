import type {
  Channel,
  Event,
  Namespace,
  SubscribeParams,
} from "@langchain/protocol";

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
