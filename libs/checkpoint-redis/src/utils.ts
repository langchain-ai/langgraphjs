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
