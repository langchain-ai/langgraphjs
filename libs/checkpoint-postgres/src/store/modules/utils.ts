/**
 * Characters interpreted as wildcards (or escape) by Postgres `LIKE` patterns.
 * Search operations match namespaces via `namespace_path LIKE ${prefix}%`, so
 * any of these in a caller-supplied label silently changes the prefix match
 * into a glob. A namespace prefix of `["%"]` would match every namespace in
 * the store, exposing data across tenants. CWE-1336 / CWE-943.
 *
 * Equality-path operations (get / put / delete) use `namespace_path = $1` and
 * are safe on their own, but we reject these characters everywhere to keep the
 * Store API consistent (data written under such a namespace would never be
 * reachable via search anyway).
 */
const LIKE_RESERVED_PATTERN = /[%_\\]/;

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
