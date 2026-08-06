// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  buildSelectCheckpointSQL,
  decodeCheckpointNamespace,
  encodeCheckpointNamespace,
  getOracleCheckpointTables,
  getPendingSendsParams,
  validateTablePrefix,
} from "../sql.js";

describe("Oracle SQL helpers", () => {
  test("validates and normalizes table prefixes", () => {
    expect(validateTablePrefix()).toBe("LANGGRAPH_");
    expect(validateTablePrefix("demo_")).toBe("DEMO_");
    expect(validateTablePrefix("")).toBe("");
    expect(() => validateTablePrefix("1bad")).toThrow(
      /must start with a letter/
    );
    expect(() => validateTablePrefix("A".repeat(120))).toThrow(
      /exceeds 128 characters/
    );
    for (const invalidPrefix of [
      "bad;drop",
      "bad'quote",
      "bad prefix",
      "bad-prefix",
      "bad--comment",
      "bad/*comment*/",
    ]) {
      expect(() => validateTablePrefix(invalidPrefix)).toThrow(
        /contain only letters, numbers, or underscores/
      );
    }
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
    expect(decodeCheckpointNamespace("legacy-namespace")).toBe(
      "legacy-namespace"
    );
  });

  test("builds checkpoint SELECT filters and pending-send params", () => {
    const select = buildSelectCheckpointSQL(
      {
        threadId: "thread-1",
        checkpointNs: "",
        checkpointId: "checkpoint-2",
        beforeCheckpointId: "checkpoint-9",
        limit: 3,
      },
      "lg_"
    );

    expect(select.sql).toContain("FROM LG_CHECKPOINTS");
    expect(select.sql).toContain("WHERE thread_id = :thread_id");
    expect(select.sql).toContain("checkpoint_ns = :checkpoint_ns");
    expect(select.sql).toContain("checkpoint_id = :checkpoint_id");
    expect(select.sql).toContain("checkpoint_id < :before_checkpoint_id");
    expect(select.sql).toContain("FETCH FIRST 3 ROWS ONLY");
    expect(select.binds).toMatchObject({
      thread_id: "thread-1",
      checkpoint_ns: encodeCheckpointNamespace(""),
      checkpoint_id: "checkpoint-2",
      before_checkpoint_id: "checkpoint-9",
    });

    expect(getPendingSendsParams("thread-1", "", ["a", "b"])).toMatchObject({
      thread_id: "thread-1",
      checkpoint_ns: encodeCheckpointNamespace(""),
      checkpoint_ids_json: JSON.stringify(["a", "b"]),
      tasks_channel: "__pregel_tasks",
    });
  });

  test("rejects invalid checkpoint SELECT limits", () => {
    expect(() => buildSelectCheckpointSQL({ limit: -1 })).toThrow(
      "Oracle checkpoint SELECT limit must be a non-negative integer."
    );
    expect(() => buildSelectCheckpointSQL({ limit: Number.NaN })).toThrow(
      "Oracle checkpoint SELECT limit must be a non-negative integer."
    );
    expect(() => buildSelectCheckpointSQL({ limit: 1.5 })).toThrow(
      "Oracle checkpoint SELECT limit must be a non-negative integer."
    );
  });
});
