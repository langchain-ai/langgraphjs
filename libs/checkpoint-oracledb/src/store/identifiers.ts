// Copyright (c) 2026, Oracle and/or its affiliates.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ORACLE_IDENTIFIER_MAX_LENGTH } from "./constants.js";

export function validateIdentifier(identifier: string): string {
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
