// Copyright (c) 2026, Oracle and/or its affiliates.
import { Buffer } from "node:buffer";

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

/** Pool sizing, named as in Python's `pool_config`. */
export interface OraclePoolConfig {
  minSize?: number;
  maxSize?: number;
}

const CONN_STRING_ERROR =
  "Invalid Oracle connection string format. Expected 'user/password@host:port/service_name'";

/**
 * Split `user/password@dsn` the way Python's `_validate_conn_string` does.
 */
export const parseOracleConnectionString = (
  connString: string
): { user: string; password: string; connectString: string } => {
  if (typeof connString !== "string") throw new Error(CONN_STRING_ERROR);

  const parts = connString.split("@");
  if (parts.length !== 2) throw new Error(CONN_STRING_ERROR);

  const [userPass, connectString] = parts;
  const userParts = userPass.split("/");
  if (userParts.length !== 2) throw new Error(CONN_STRING_ERROR);

  const [user, password] = userParts;
  return { user, password, connectString };
};

/** Map Python's `pool_config` onto node-oracledb pool options. */
export const poolConfigToConnectionOptions = (
  poolConfig?: OraclePoolConfig
): { poolMin?: number; poolMax?: number } =>
  poolConfig
    ? { poolMin: poolConfig.minSize ?? 1, poolMax: poolConfig.maxSize ?? 10 }
    : {};

export const oracleConstraintName = (
  tableName: string,
  suffix: string
): string => {
  const maxPrefixLength = ORACLE_IDENTIFIER_MAX_LENGTH - suffix.length - 1;
  return `${tableName.slice(0, maxPrefixLength)}_${suffix}`;
};
