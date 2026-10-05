// RedisStore stores a namespace as its labels joined with ".".

/**
 * Whether a label contains ".", so that the joined namespace is ambiguous:
 * `["a.b"]` and `["a", "b"]` join to the same prefix. `put()` rejects such
 * labels, so a read through one can only reach another namespace.
 */
export function hasDottedLabel(namespace: string[]): boolean {
  return namespace.some((label) => String(label).includes("."));
}

/** Whether a document stored under `prefix` is in `namespace` or below it. */
export function isWithinNamespace(
  prefix: string,
  namespace: string[]
): boolean {
  if (namespace.length === 0) {
    return true;
  }
  const path = namespace.join(".");
  return prefix === path || prefix.startsWith(`${path}.`);
}
