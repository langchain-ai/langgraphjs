/**
 * How RedisStore narrows queries to a namespace.
 *
 * A document stores its namespace as `prefix`, the labels joined with ".".
 * The queries built here only narrow the candidates; the store compares
 * `prefix` itself before it returns, replaces or deletes a document.
 */

/**
 * Whether `namespace.join(".")` names only `namespace`. It does unless a label
 * is empty or contains the separator: `["a.b"]` and `["a", "b"]` both join to
 * `"a.b"`, and `[""]` joins to `""`, the prefix of every namespace.
 */
export function joinsUnambiguously(namespace: string[]): boolean {
  return namespace.every(
    (label) => typeof label === "string" && label !== "" && !label.includes(".")
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

/**
 * The query earlier versions' vector search narrowed with: the first word of
 * the namespace only.
 */
export function prefixWildcardQuery(namespace: string[]): string {
  const prefix = namespace.join(".");
  return prefix ? `@prefix:${prefix.split(/[.-]/)[0]}*` : "*";
}

/**
 * Match every clause, as earlier versions combined them. `*` matches
 * everything, so it drops out; RediSearch rejects `(*) (@key:{k})` as a
 * syntax error. A single clause is sent as it is.
 */
export function allOf(...clauses: string[]): string {
  const narrowing = clauses.filter((clause) => clause !== "*");
  if (narrowing.length < 2) {
    return narrowing[0] ?? "*";
  }
  return narrowing.map((clause) => `(${clause})`).join(" ");
}
