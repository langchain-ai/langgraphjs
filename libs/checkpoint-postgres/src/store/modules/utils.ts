/**
 * Reject LIKE metacharacters consistently across reads, writes and list filters.
 * Pattern construction also escapes them as a defense in depth.
 */
const LIKE_RESERVED_PATTERN = /[%_\\]/;

/**
 * Validates the provided namespace.
 * @param namespace The namespace to validate.
 * @param options Whether the path starts at the namespace root (false for suffixes).
 * @throws {Error} If the namespace is invalid.
 */
export function validateNamespace(
  namespace: string[],
  { isRoot = true }: { isRoot?: boolean } = {}
): void {
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
        `Invalid namespace label '${label}'. Namespace labels cannot contain colons (':').`
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
          `labels cannot contain SQL LIKE wildcards ('%', '_') or backslashes.`
      );
    }
  }
  if (isRoot && namespace[0] === "langgraph") {
    throw new Error(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`
    );
  }
}

/** Escape LIKE wildcards and PostgreSQL's default backslash escape character. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Listing wildcards span one segment; stars inside a label remain literal. */
export function namespaceListingCondition(
  namespace: string[],
  matchType: "prefix" | "suffix",
  params: unknown[]
): string {
  if (!namespace.includes("*")) {
    const path = namespace.join(":");
    const escapedPath = escapeLike(path);
    const paramIndex = params.length + 1;
    params.push(
      path,
      matchType === "prefix" ? `${escapedPath}:%` : `%:${escapedPath}`
    );
    return `(namespace_path = $${paramIndex} OR namespace_path LIKE $${paramIndex + 1})`;
  }
  const body = namespace
    .map((label) =>
      label === "*" ? "[^:]+" : label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join(":");
  // PostgreSQL's \Z anchors at the actual end, including for newline labels.
  params.push(matchType === "prefix" ? `^${body}(:|\\Z)` : `(^|:)${body}\\Z`);
  return `namespace_path ~ $${params.length}`;
}
