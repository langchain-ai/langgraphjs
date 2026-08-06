// Copyright (c) 2026, Oracle and/or its affiliates.
import { Buffer } from "node:buffer";

export const DEFAULT_TABLE_PREFIX = "LANGGRAPH_";
export const ORACLE_IDENTIFIER_MAX_LENGTH = 128;

export type OracleRowLike = Record<string, unknown>;

export const oracleErrorCode = (
  error: unknown
): number | string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { errorNum?: number; code?: number | string })
    .errorNum;
  return code ?? (error as { code?: number | string }).code;
};

export const isOracleError = (error: unknown, code: number): boolean => {
  const actual = oracleErrorCode(error);
  return actual === code || actual === `ORA-${String(code).padStart(5, "0")}`;
};

export const rowValue = <T>(row: OracleRowLike, key: string): T =>
  (row[key] ?? row[key.toUpperCase()]) as T;

export const optionalRowValue = <T>(
  row: OracleRowLike,
  key: string
): T | undefined => rowValue<T | undefined>(row, key);

export const validateUtf8ByteLength = (
  context: string,
  label: string,
  value: string | null | undefined,
  maxBytes: number,
  suffix = ""
): void => {
  if (value === null || value === undefined) return;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `${context} ${label} exceeds ${maxBytes} bytes${suffix}. Received ${byteLength} bytes.`
    );
  }
};

export const oracleConstraintName = (
  tableName: string,
  suffix: string
): string => {
  const maxPrefixLength = ORACLE_IDENTIFIER_MAX_LENGTH - suffix.length - 1;
  return `${tableName.slice(0, maxPrefixLength)}_${suffix}`;
};
