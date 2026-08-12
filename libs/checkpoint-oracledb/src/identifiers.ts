// Copyright (c) 2026, Oracle and/or its affiliates.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ORACLE_IDENTIFIER_MAX_LENGTH } from "./utils.js";

export function validateIdentifier(identifier: string): string {
  // Checked before toUpperCase(): some non-ASCII characters upper-case into
  // ASCII (U+0131 -> I, U+017F -> S), so validating the folded form would let
  // them through.
  if (typeof identifier !== "string") {
    throw new Error(`Invalid Oracle identifier: ${String(identifier)}`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(identifier)) {
    throw new Error(`Invalid Oracle identifier: ${identifier}`);
  }
  const normalized = identifier.toUpperCase();
  if (Buffer.byteLength(normalized, "utf8") > ORACLE_IDENTIFIER_MAX_LENGTH) {
    throw new Error(
      `Oracle identifier "${normalized}" exceeds ${ORACLE_IDENTIFIER_MAX_LENGTH} bytes.`
    );
  }
  return normalized;
}

export function generatedIdentifier(identifier: string): string {
  const normalized = identifier.toUpperCase();
  if (Buffer.byteLength(normalized, "utf8") <= ORACLE_IDENTIFIER_MAX_LENGTH) {
    return validateIdentifier(normalized);
  }

  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  const suffix = `_${hash}`;
  let prefix = normalized.slice(
    0,
    ORACLE_IDENTIFIER_MAX_LENGTH - suffix.length
  );
  while (
    Buffer.byteLength(`${prefix}${suffix}`, "utf8") >
    ORACLE_IDENTIFIER_MAX_LENGTH
  ) {
    prefix = prefix.slice(0, -1);
  }
  return validateIdentifier(`${prefix}${suffix}`);
}

/**
 * Validate a caller-supplied table suffix.
 *
 * Same rule as Python's `_validate_table_suffix`, and deliberately narrower
 * than {@link validateIdentifier}: the suffix is concatenated onto a base name,
 * so it must be safe in that position and must not rely on Oracle quoting.
 */
export function validateTableSuffix(suffix: string): string {
  if (
    typeof suffix !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(suffix)
  ) {
    throw new Error(
      "tableSuffix must start with a letter and contain only letters, digits, or underscores, with a maximum length of 64 characters."
    );
  }
  return suffix;
}

/**
 * Build a table name from a base and an optional suffix.
 *
 * The result is always an unquoted, upper-case Oracle identifier, so the same
 * name resolves regardless of the case the caller used.
 */
export function suffixedTableName(base: string, suffix?: string): string {
  const name = suffix ? `${base}_${validateTableSuffix(suffix)}` : base;
  return validateIdentifier(name);
}
