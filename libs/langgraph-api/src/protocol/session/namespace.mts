import type { Namespace } from "../types.mjs";

/**
 * Converts a namespace array into a stable internal lookup key.
 *
 * @param namespace - Namespace segments to encode.
 * @returns A string key that preserves segment boundaries.
 */
export const toNamespaceKey = (namespace: Namespace) => namespace.join("\0");

/**
 * Strips dynamic suffixes from a namespace segment for display purposes.
 *
 * @param segment - Raw namespace segment.
 * @returns The stable graph-oriented portion of the segment.
 */
export const normalizeNamespaceSegment = (segment: string) =>
  segment.split(":")[0];

/**
 * Preserves raw namespace segments in protocol events.
 *
 * @param namespace - Namespace segments parsed from the source event.
 * @returns The namespace exactly as it should be exposed to clients.
 */
export const normalizeNamespace = (namespace: string[]): Namespace => namespace;

/**
 * Splits a stream event name into its method and namespace components.
 *
 * @param event - Raw event name emitted by the source stream.
 * @returns The parsed method plus namespace segments.
 */
export const parseEventName = (event: string) => {
  const [method, ...namespace] = event.split("|");
  return { method, namespace };
};

/**
 * Checks whether a namespace starts with a requested prefix.
 *
 * @param namespace - Event namespace to test.
 * @param prefix - Subscription namespace prefix.
 * @returns Whether the namespace matches the prefix semantics.
 */
export const isPrefixMatch = (namespace: Namespace, prefix: Namespace) => {
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, index) => {
    const candidate = namespace[index];
    if (candidate === segment) return true;
    if (segment.includes(":")) return false;
    return normalizeNamespaceSegment(candidate) === segment;
  });
};

/**
 * Guesses a human-readable graph name from a namespace.
 *
 * @param namespace - Namespace segments for a graph or subgraph.
 * @returns The derived graph name, or `root` when no segments exist.
 */
export const guessGraphName = (namespace: Namespace) => {
  const last = namespace.at(-1);
  if (last == null) return "root";
  return normalizeNamespaceSegment(last);
};
