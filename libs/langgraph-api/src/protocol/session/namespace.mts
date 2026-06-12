import {
  isPrefixMatch,
  normalizeNamespaceSegment,
} from "@langchain/langgraph/stream";
import type { Namespace } from "../types.mjs";

/**
 * Namespace prefix matching and dynamic-suffix normalization are shared with
 * the core streaming toolkit so the server, the SDK, and custom transports all
 * agree on subscription semantics.
 */
export { isPrefixMatch, normalizeNamespaceSegment };

/**
 * Converts a namespace array into a stable internal lookup key.
 *
 * @param namespace - Namespace segments to encode.
 * @returns A string key that preserves segment boundaries.
 */
export const toNamespaceKey = (namespace: Namespace) => namespace.join("\0");

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
