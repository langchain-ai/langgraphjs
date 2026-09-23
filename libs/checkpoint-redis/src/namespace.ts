/**
 * How RedisStore narrows queries to a namespace.
 *
 * A document stores its namespace as `prefix`, the labels joined with ".".
 * The queries built here only narrow the candidates; the store compares
 * `prefix` itself before it returns, replaces or deletes a document.
 */

/**
 * Whether `namespace.join(".")` names only `namespace`. It does unless a label
 * contains the separator: `["a.b"]` and `["a", "b"]` both join to `"a.b"`.
 */
export function joinsUnambiguously(namespace: string[]): boolean {
  return namespace.every(
    (label) => typeof label === "string" && !label.includes(".")
  );
}

/** Whether a document stored under `prefix` is in `namespace` or below it. */
export function isWithinNamespace(
  prefix: string,
  namespace: string[]
): boolean {
  const target = namespace.join(".");
  return target === "" || prefix === target || prefix.startsWith(`${target}.`);
}

/** The text query RedisStore has always narrowed a namespace with. */
export function prefixTextQuery(namespace: string[]): string {
  const tokens = namespace
    .join(".")
    .split(/[.-]/)
    .filter((t) => t.length > 0);
  return tokens.length > 0 ? `@prefix:(${tokens.join(" ")})` : "*";
}

/** The vector search's form of {@link prefixTextQuery}. */
export function prefixWildcardQuery(namespace: string[]): string {
  const prefix = namespace.join(".");
  return prefix ? `@prefix:${prefix.split(/[.-]/)[0]}*` : "*";
}

/**
 * Match every clause. `*` matches everything, so it drops out; RediSearch
 * rejects `(*) (@key:{k})` as a syntax error.
 */
export function allOf(...clauses: string[]): string {
  const narrowing = clauses.filter((clause) => clause !== "*");
  return narrowing.length > 0
    ? narrowing.map((clause) => `(${clause})`).join(" ")
    : "*";
}
