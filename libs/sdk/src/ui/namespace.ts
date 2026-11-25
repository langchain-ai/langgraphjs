import { NAMESPACE_SEPARATOR } from "./constants.js";

/**
 * Stable string key for a protocol namespace tuple.
 */
export function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

/**
 * True when an event is scoped to the root namespace.
 */
export function isRootNamespace(namespace: readonly string[]): boolean {
  return namespace.length === 0;
}

/**
 * True when a namespace segment points at a tool execution namespace.
 */
export function isToolNamespaceSegment(segment: string): boolean {
  return segment.startsWith("tools:");
}

/**
 * True when a namespace segment points at a legacy task/subagent namespace.
 */
export function isTaskNamespaceSegment(segment: string): boolean {
  return segment.startsWith("task:");
}

/**
 * True when a namespace belongs to tool/subagent-internal work.
 */
export function isInternalWorkNamespace(namespace: readonly string[]): boolean {
  return namespace.some(
    (segment) =>
      isTaskNamespaceSegment(segment) || isToolNamespaceSegment(segment)
  );
}

/**
 * True when a namespace includes the legacy task/subagent convention.
 */
export function isLegacySubagentNamespace(
  namespace: readonly string[]
): boolean {
  return namespace.some(isTaskNamespaceSegment);
}

/**
 * True when the namespace itself is a concrete tool execution namespace.
 *
 * Several subagents started by one tool node run concurrently on sibling
 * namespaces: the first at `["tools:<id>"]`, the rest at
 * `["tools:<id>", "1"]`, `["tools:<id>", "2"]`, and so on. Those sibling
 * namespaces are concrete tool execution namespaces too.
 */
export function isConcreteToolNamespace(namespace: readonly string[]): boolean {
  const last = namespace.at(-1);
  if (last != null && isToolNamespaceSegment(last)) return true;
  const previous = namespace.at(-2);
  return (
    last != null &&
    previous != null &&
    isToolNamespaceSegment(previous) &&
    /^\d+$/.test(last)
  );
}
