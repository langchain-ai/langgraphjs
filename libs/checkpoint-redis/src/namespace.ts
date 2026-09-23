/**
 * How RedisStore narrows queries to a namespace.
 *
 * A document stores its namespace as `prefix`, the labels joined with ".".
 * The queries built here only narrow the candidates; the store compares
 * `prefix` itself before it returns, replaces or deletes a document.
 */

/** A RediSearch query and the parameters it references. */
export interface Query {
  query: string;
  params?: Record<string, string>;
}

/** Field holding the whole namespace as one tag. */
export const PREFIX_EXACT = "prefix_exact";

/** Field holding each label of the namespace as a tag. */
export const PREFIX_LABELS = "prefix_labels";

/** The fields setup() adds over `$.prefix`. */
export const NAMESPACE_FIELDS = [
  // A JSON TAG field has no separator, so this stores the whole string
  { "$.prefix": { type: "TAG", AS: PREFIX_EXACT, CASESENSITIVE: true } },
  {
    "$.prefix": {
      type: "TAG",
      AS: PREFIX_LABELS,
      SEPARATOR: ".",
      CASESENSITIVE: true,
    },
  },
];

/** The namespace fields an FT.INFO reply, read as a map, does not list. */
export function missingFields(info: Record<string, unknown>) {
  const attributes = Array.isArray(info.attributes) ? info.attributes : [];
  const names = attributes
    .filter(Array.isArray)
    .map((attribute) => attribute[attribute.indexOf("attribute") + 1]);
  return NAMESPACE_FIELDS.filter(
    (field) => !names.includes(field["$.prefix"].AS)
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

// RediSearch stores and compares values as C strings, up to the first NUL.
function upToNul(value: string): string {
  return value.split("\0")[0];
}

// RediSearch matches a parameter as a value, not as query syntax, except that
// it still drops a backslash that comes before punctuation or whitespace.
function asParam(value: string): string {
  return value.replaceAll("\\", "\\\\");
}

/**
 * Query for the documents stored under exactly `namespace`, with `key` if it
 * is not empty. Redis compares the whole namespace, so only a namespace that
 * contains a NUL can match others; the key field ignores case, as it always
 * has.
 */
export function documentQuery(namespace: string[], key: string): Query {
  const values: [string, string, string][] = [
    [PREFIX_EXACT, "ns", upToNul(namespace.join("."))],
    ["key", "key", upToNul(key)],
  ];
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  for (const [field, param, value] of values) {
    // RediSearch cannot match an empty tag; leaving it out only widens
    if (value !== "") {
      clauses.push(`@${field}:{$${param}}`);
      params[param] = asParam(value);
    }
  }
  return clauses.length > 0
    ? { query: clauses.join(" "), params }
    : { query: "*" };
}

/**
 * Query for the documents in `namespace` or below it: those tagged with every
 * label. Tags are unordered, so it also matches other namespaces that share
 * those labels.
 */
export function subtreeQuery(namespace: string[]): Query {
  const labels = upToNul(namespace.join("."))
    .split(".")
    .map(asStoredLabel)
    .filter((label): label is string => label !== undefined);
  if (labels.length === 0) {
    return { query: "*" };
  }
  return {
    query: labels.map((_, i) => `@${PREFIX_LABELS}:{$l${i}}`).join(" "),
    params: Object.fromEntries(
      labels.map((label, i) => [`l${i}`, asParam(label)])
    ),
  };
}

/**
 * A label as the labels field stores it. RediSearch trims leading and trailing
 * whitespace from each tag and keeps at most 4096 bytes of it. A label it keeps
 * nothing of, or cuts short, is left out, which only widens the query.
 */
function asStoredLabel(label: string): string | undefined {
  const tag = label.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  return tag !== "" && Buffer.byteLength(tag) <= 4096 ? tag : undefined;
}

/** The text query RedisStore used before the namespace fields existed. */
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
