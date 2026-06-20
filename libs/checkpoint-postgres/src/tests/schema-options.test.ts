import { describe, it, expect } from "vitest";
import { PostgresSaver } from "../index.js";
import { PostgresStore } from "../store/index.js";

const CONN = "postgresql://user:pass@localhost:5432/db";
const GUARD_MESSAGE = /"createSchema" requires a custom "schema"/;

// These tests only exercise option validation, which runs synchronously in the
// constructor before any connection is made, so no live database is required.

describe("schema / createSchema coupling", () => {
  describe("PostgresSaver", () => {
    it("rejects createSchema without a custom schema at runtime", () => {
      expect(() =>
        // @ts-expect-error createSchema is not allowed without schema
        PostgresSaver.fromConnString(CONN, { createSchema: false })
      ).toThrow(GUARD_MESSAGE);
    });

    it("allows createSchema alongside a custom schema", () => {
      expect(() =>
        PostgresSaver.fromConnString(CONN, {
          schema: "custom",
          createSchema: false,
        })
      ).not.toThrow();
    });

    it("allows a bare schema and defaults createSchema", () => {
      expect(() =>
        PostgresSaver.fromConnString(CONN, { schema: "custom" })
      ).not.toThrow();
    });

    it("allows no options at all", () => {
      expect(() => PostgresSaver.fromConnString(CONN)).not.toThrow();
    });
  });

  describe("PostgresStore", () => {
    it("rejects createSchema without a custom schema at runtime", () => {
      expect(
        () =>
          // @ts-expect-error createSchema is not allowed without schema
          new PostgresStore({
            connectionOptions: CONN,
            createSchema: false,
          })
      ).toThrow(GUARD_MESSAGE);
    });

    it("allows createSchema alongside a custom schema", () => {
      expect(
        () =>
          new PostgresStore({
            connectionOptions: CONN,
            schema: "custom",
            createSchema: false,
          })
      ).not.toThrow();
    });

    it("rejects createSchema without schema through fromConnString", () => {
      expect(() =>
        // @ts-expect-error createSchema is not allowed without schema
        PostgresStore.fromConnString(CONN, { createSchema: false })
      ).toThrow(GUARD_MESSAGE);
    });
  });
});
