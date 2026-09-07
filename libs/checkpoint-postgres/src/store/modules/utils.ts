/**
 * Characters interpreted as wildcards (or escape) by Postgres `LIKE` patterns.
 * Search operations previously matched namespaces via `namespace_path LIKE ${prefix}%`,
 * so any of these in a caller-supplied label silently changed the prefix match
 * into a glob. A namespace prefix of `["%"]` would match every namespace in
 * the store, exposing data across tenants. CWE-1336 / CWE-943.
 *
 * Equality-path operations (get / put / delete) use `namespace_path = $1` and
 * are safe on their own, but we reject these characters everywhere to keep the
 * Store API consistent (data written under such a namespace would never be
 * reachable via search anyway).
 *
 * Prefix scoping now uses `= path OR LIKE path:%` (see `namespaceScopeClause`)
 * so sibling namespaces that share a string prefix are no longer returned.
 * `#2721` / CVE-2026-71433. `%` / `_` / `\` are still rejected rather than
 * escaped, matching #2512.
 */
const LIKE_RESERVED_PATTERN = /[%_\\]/;

/** Joiner used when persisting a namespace array as `namespace_path`. */
export const NAMESPACE_SEPARATOR = ":";

/**
 * Build the two bound params for a segment-aware prefix (or suffix) match.
 *
 * Exact equality covers the namespace itself; `LIKE path:%` covers descendants
 * without also matching siblings such as `acme` vs `acme-corp`.
 */
export function namespaceScopeParams(
  segments: string[],
  kind: "prefix" | "suffix" = "prefix"
): { exact: string; like: string } {
  const exact = segments.join(NAMESPACE_SEPARATOR);
  if (kind === "suffix") {
    return { exact, like: `%${NAMESPACE_SEPARATOR}${exact}` };
  }
  return { exact, like: `${exact}${NAMESPACE_SEPARATOR}%` };
}

/**
 * SQL fragment: `column` equals the bound path, or is a descendant of it.
 * Consumes two parameters starting at `startIndex`.
 */
export function namespaceScopeClause(
  column: string,
  startIndex: number
): { clause: string; nextIndex: number } {
  return {
    clause: `(${column} = $${startIndex} OR ${column} LIKE $${startIndex + 1})`,
    nextIndex: startIndex + 2,
  };
}

/**
 * POSIX regex matching a colon-joined namespace on whole segments.
 *
 * Needed when a listNamespaces path contains `*` (one segment). LIKE cannot
 * express "any character except the separator". Prefix matches stay
 * open-ended but must end on a separator; suffix matches anchor at the end.
 */
export function namespaceMatchRegex(
  path: string[],
  matchType: "prefix" | "suffix"
): string {
  const segments = path.map((part) =>
    part === "*" ? "[^:]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const body = segments.join(":");
  if (matchType === "suffix") {
    return `(^|:)${body}$`;
  }
  return `^${body}(:|$)`;
}

/**
 * Validates the provided namespace.
 * @param namespace The namespace to validate.
 * @throws {Error} If the namespace is invalid.
 */
export function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) {
    throw new Error("Namespace cannot be empty.");
  }
  for (const label of namespace) {
    if (typeof label !== "string") {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels ` +
          `must be strings, but got ${typeof label}.`
      );
    }
    if (label.includes(".")) {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`
      );
    }
    if (label.includes(":")) {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain colons (':'), which are the namespace path separator.`
      );
    }
    if (label === "") {
      throw new Error(
        `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`
      );
    }
    if (LIKE_RESERVED_PATTERN.test(label)) {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace ` +
          `labels cannot contain SQL LIKE wildcards ('%', '_') or the ` +
          `backslash escape character ('\\\\'); these would cause search() to ` +
          `match namespaces outside the requested prefix.`
      );
    }
  }
  if (namespace[0] === "langgraph") {
    throw new Error(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`
    );
  }
}
