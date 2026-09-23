/**
 * How RedisStore narrows queries to a namespace.
 *
 * A document stores its namespace as `prefix`, the labels joined with ".".
 * The queries built here only narrow the candidates; the store compares
 * `prefix` itself before it returns, replaces or deletes a document.
 */

/** The index field setup() adds: each namespace label as an exact tag. */
export const NAMESPACE_LABELS = "prefix_labels";

export const NAMESPACE_LABELS_SCHEMA = {
  "$.prefix": {
    type: "TAG",
    AS: NAMESPACE_LABELS,
    SEPARATOR: ".",
    CASESENSITIVE: true,
  },
};

/** Whether an FT.INFO reply, read as a map, lists the labels field. */
export function hasNamespaceLabels(info: Record<string, unknown>): boolean {
  const attributes = info.attributes;
  return (
    Array.isArray(attributes) &&
    attributes.some(
      (attribute) =>
        Array.isArray(attribute) &&
        attribute[attribute.indexOf("attribute") + 1] === NAMESPACE_LABELS
    )
  );
}

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

/**
 * Query for documents tagged with every label of `namespace`. Tags are
 * unordered, so it also matches other namespaces that share those labels.
 */
export function namespaceLabelsQuery(namespace: string[]): string {
  const clauses = namespace
    .filter(isMatchableTag)
    .map((label) => `@${NAMESPACE_LABELS}:{${escapeTag(label)}}`);
  return clauses.length > 0 ? clauses.join(" ") : "*";
}

/**
 * Whether RediSearch matches `label` exactly as a tag. Measured on Redis 7.4
 * and 8, it misses labels that are empty, start or end with a space, or are
 * longer than 4096 bytes, and most that contain an ASCII control character.
 * Leaving such a label out of the query only widens it.
 */
function isMatchableTag(label: string): boolean {
  return (
    label !== "" &&
    !label.startsWith(" ") &&
    !label.endsWith(" ") &&
    Array.from(label).every((ch) => ch >= " " && ch !== "\x7f") &&
    Buffer.byteLength(label) <= 4096
  );
}

/** Backslash-escape every ASCII character that is not a letter or digit. */
function escapeTag(label: string): string {
  return label.replace(/[^0-9A-Za-z]/g, (ch) =>
    ch.charCodeAt(0) < 128 ? `\\${ch}` : ch
  );
}

/**
 * The text query RedisStore used before the labels field existed. Queries use
 * it until the field is ready, so they find what they always found.
 */
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
