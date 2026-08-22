// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  isOracleError,
  optionalRowValue,
  oracleConstraintName,
  oracleErrorCode,
  parseOracleConnectionString,
  poolConfigToConnectionOptions,
  rowValue,
} from "../utils.js";

describe("Oracle utils", () => {
  test("extracts Oracle error codes from supported error shapes", () => {
    expect(oracleErrorCode({ errorNum: 942, code: "ORA-00942" })).toBe(942);
    expect(oracleErrorCode({ code: "ORA-00001" })).toBe("ORA-00001");
    expect(oracleErrorCode({ code: 1 })).toBe(1);
    expect(oracleErrorCode(null)).toBeUndefined();
    expect(oracleErrorCode("ORA-00001")).toBeUndefined();
  });

  test("matches numeric and ORA-prefixed error codes", () => {
    expect(isOracleError({ errorNum: 1 }, 1)).toBe(true);
    expect(isOracleError({ code: "ORA-00001" }, 1)).toBe(true);
    expect(isOracleError({ code: "ORA-00942" }, 942)).toBe(true);
    expect(isOracleError({ code: "ORA-00955" }, 942)).toBe(false);
  });

  test("reads row values from lower-case and upper-case keys", () => {
    expect(rowValue<string>({ name: "lower" }, "name")).toBe("lower");
    expect(rowValue<string>({ NAME: "upper" }, "name")).toBe("upper");
  });

  test("returns undefined for missing optional row values", () => {
    expect(optionalRowValue({ NAME: "present" }, "missing")).toBeUndefined();
  });

  test("builds Oracle constraint names within identifier limits", () => {
    const shortName = oracleConstraintName("LANGGRAPH_STORE", "Pk");
    expect(shortName).toBe("LANGGRAPH_STORE_Pk");

    const longName = oracleConstraintName("A".repeat(200), "JsonCheck");
    expect(longName).toMatch(/_JsonCheck$/);
    expect(Buffer.byteLength(longName, "utf8")).toBeLessThanOrEqual(128);
  });

  test("parses the Python user/password@dsn connection string", () => {
    expect(
      parseOracleConnectionString("scott/tiger@localhost:1521/FREEPDB1")
    ).toEqual({
      user: "scott",
      password: "tiger",
      connectString: "localhost:1521/FREEPDB1",
    });
  });

  test("rejects the formats Python rejects", () => {
    for (const connString of [
      "localhost:1521/FREEPDB1",
      "scott@localhost:1521/FREEPDB1",
      "scott/tiger/extra@localhost:1521/FREEPDB1",
      "scott/tiger@host@other",
      "",
      42 as never,
    ]) {
      expect(() => parseOracleConnectionString(connString)).toThrow(
        "Invalid Oracle connection string format"
      );
    }
  });

  test("maps pool_config onto node-oracledb pool options", () => {
    expect(poolConfigToConnectionOptions()).toEqual({});
    // Python defaults: min 1, max 10.
    expect(poolConfigToConnectionOptions({})).toEqual({
      poolMin: 1,
      poolMax: 10,
    });
    expect(poolConfigToConnectionOptions({ minSize: 2, maxSize: 4 })).toEqual({
      poolMin: 2,
      poolMax: 4,
    });
  });
});
