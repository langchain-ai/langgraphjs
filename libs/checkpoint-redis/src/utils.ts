/**
 * Escape special characters in a string for use in RediSearch TAG field queries.
 *
 * RediSearch TAG fields have special characters that need escaping when used
 * within curly braces: , . < > { } [ ] " ' : ; ! @ # $ % ^ & * ( ) - + = ~ | \ ? /
 *
 * This function is used to prevent RediSearch query injection attacks when
 * building queries with user-provided filter values.
 *
 * @param value - The string value to escape
 * @returns The escaped string safe for use in RediSearch TAG queries
 */
export function escapeRediSearchTagValue(value: string): string {
  // Handle empty string as a special case - use a placeholder
  if (value === "") {
    return "__EMPTY_STRING__";
  }
  // Escape backslashes first, then all other special characters
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[-\s,.:<>{}[\]"';!@#$%^&*()+=~|?/]/g, "\\$&");
}

/**
 * Punctuation that RediSearch strips when it tokenizes a TEXT field.
 *
 * Query terms have to be split on the same set the indexer uses. A term that
 * still carries one of these characters does not address an indexed term: it
 * either fails to parse or, worse, closes the surrounding `@prefix:(...)`
 * clause and lets a caller-controlled namespace label inject query syntax
 * (`"acme) | @prefix:(victim"` would otherwise OR in another tenant).
 */
const REDISEARCH_TEXT_PUNCTUATION = /[-\s,.:<>{}[\]"';!@#$%^&*()+=~|?/\\]/;

/**
 * Builds the RediSearch clause that scopes a query to a namespace prefix.
 *
 * Namespaces are indexed as a single TEXT field, so the clause has to carry the
 * tokens of every label: dropping one widens the match to unrelated namespaces.
 * Only terms the indexer could have produced are emitted, never raw label text.
 *
 * @param namespacePrefix - Namespace labels to scope the query to
 * @returns The RediSearch clause, or `*` when the prefix carries no labels
 */
export function buildNamespacePrefixQuery(namespacePrefix: string[]): string {
  const tokens = namespacePrefix
    .flatMap((label) => label.split(REDISEARCH_TEXT_PUNCTUATION))
    .filter((token) => token.length > 0);

  if (tokens.length > 0) {
    return `@prefix:(${tokens.join(" ")})`;
  }

  if (namespacePrefix.every((label) => label.length === 0)) {
    return "*";
  }

  // A label made only of punctuation indexes no term, so no document can match
  // it. Escaping keeps the clause parseable instead of falling back to `*`,
  // which would widen the search to every namespace.
  const escaped = namespacePrefix.map((label) =>
    escapeRediSearchTagValue(label)
  );

  return `@prefix:(${escaped.join(" ")})`;
}

/**
 * Characters that are interpreted as wildcards or escapes by Redis pattern
 * commands (KEYS, SCAN MATCH, PSUBSCRIBE, etc.). Embedding any of these in a
 * caller-controlled key component allows pattern injection: a `thread_id` of
 * `"*"` causes `KEYS "checkpoint:*:..."` to enumerate every tenant, and
 * inside `deleteThread` deletes them.
 *
 * The `:` delimiter is intentionally NOT rejected. LangGraph emits it as a
 * legitimate part of `checkpoint_ns` for subgraphs / nested graphs, where the
 * namespace is built as `${name}${CHECKPOINT_NAMESPACE_END}${taskId}` with
 * `CHECKPOINT_NAMESPACE_END === ":"` (joined by `|`). Rejecting `:` would
 * throw on every subgraph checkpoint. The colon is only ever a literal in the
 * key, so it does not enable glob/pattern injection.
 */
const REDIS_KEY_FORBIDDEN = /[*?[\]\\]/;

/**
 * Asserts that a value sourced from {@link RunnableConfig.configurable} (or
 * any other caller-influenced position) is safe to embed directly into a
 * Redis key or KEYS / SCAN MATCH pattern.
 *
 * Without this guard a caller that can shape `thread_id`, `checkpoint_ns`,
 * `checkpoint_id`, or `task_id` (multi-tenant SDK deployments where the
 * config originates from request input, webhook bodies that flow into a
 * persisted thread, etc.) can promote a string field into a glob pattern
 * (`*`, `?`, `[...]`) or escape character (`\\`), causing the saver to
 * read, overwrite, or delete checkpoints belonging to other tenants. The
 * `deleteThread` path is the most severe: a `threadId` of `"*"` issues
 * `client.keys("checkpoint:*:*")` followed by `client.del(...)`, wiping the
 * entire database. CWE-943 (Improper Neutralization of Special Elements in
 * Data Query Logic) and CWE-77 (Improper Neutralization of Special Elements
 * in a Command).
 *
 * @param field Name of the configurable field, used in the error message.
 * @param value Value to validate.
 * @param options.allowEmpty When true the empty string is accepted (used for
 *                            the documented empty `checkpoint_ns` default);
 *                            otherwise an empty string is rejected the same
 *                            way as undefined / null.
 */
export function assertSafeKeyComponent(
  field: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): asserts value is string {
  const { allowEmpty = false } = options;
  if (typeof value !== "string") {
    const observed =
      value === null
        ? "null"
        : value === undefined
          ? "undefined"
          : Array.isArray(value)
            ? "array"
            : typeof value;
    throw new Error(
      `Invalid configurable value for key "${field}": expected a string identifier (got ${observed}). This guard protects Redis keys and KEYS/SCAN patterns from glob and command injection.`
    );
  }
  if (!allowEmpty && value === "") {
    throw new Error(
      `Invalid configurable value for key "${field}": empty string is not permitted as a Redis key component.`
    );
  }
  if (REDIS_KEY_FORBIDDEN.test(value)) {
    throw new Error(
      `Invalid configurable value for key "${field}": value contains a Redis pattern meta-character (one of * ? [ ] \\). This guard protects Redis keys and KEYS/SCAN patterns from glob and command injection.`
    );
  }
}
