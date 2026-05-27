import { describe, expect, test } from "vitest";

import {
  decodeCheckpointNamespace,
  encodeCheckpointNamespace,
  getOracleCheckpointTables,
  validateTablePrefix,
} from "../sql.js";

describe("Oracle SQL helpers", () => {
  test("validates and normalizes table prefixes", () => {
    expect(validateTablePrefix()).toBe("LANGGRAPH_");
    expect(validateTablePrefix("demo_")).toBe("DEMO_");
    expect(() => validateTablePrefix("1bad")).toThrow(
      /must start with a letter/
    );
  });

  test("builds checkpoint table names", () => {
    expect(getOracleCheckpointTables("lg_")).toEqual({
      checkpoints: "LG_CHECKPOINTS",
      checkpoint_blobs: "LG_CHECKPOINT_BLOBS",
      checkpoint_writes: "LG_CHECKPOINT_WRITES",
      checkpoint_migrations: "LG_CHECKPOINT_MIGRATIONS",
    });
  });

  test("round-trips checkpoint namespaces without sentinel collisions", () => {
    const encoded = encodeCheckpointNamespace("");
    expect(encoded).not.toBe("");
    expect(decodeCheckpointNamespace(encoded)).toBe("");
    expect(decodeCheckpointNamespace(encodeCheckpointNamespace("team"))).toBe(
      "team"
    );
    expect(
      decodeCheckpointNamespace(
        encodeCheckpointNamespace("__langgraph_empty_checkpoint_ns__")
      )
    ).toBe("__langgraph_empty_checkpoint_ns__");
  });
});
