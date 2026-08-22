// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  buildCheckpointMetadataFilter,
  buildSelectCheckpointSQL,
  decodeCheckpointNamespace,
  encodeCheckpointNamespace,
  encodeTaskPath,
  getOracleCheckpointTables,
  getPendingSendsParams,
  validateTableSuffix,
} from "../sql.js";
import { getMigrations } from "../migrations.js";

describe("Oracle SQL helpers", () => {
  test("validates table suffixes with the Python rule", () => {
    expect(validateTableSuffix("demo")).toBe("demo");
    expect(validateTableSuffix("Demo_1")).toBe("Demo_1");
    expect(() => validateTableSuffix("")).toThrow(/must start with a letter/);
    expect(() => validateTableSuffix("1bad")).toThrow(
      /must start with a letter/
    );
    expect(() => validateTableSuffix("A".repeat(65))).toThrow(
      /maximum length of 64 characters/
    );
    for (const invalidPrefix of [
      "bad;drop",
      "bad'quote",
      "bad prefix",
      "bad-prefix",
      "bad--comment",
      "bad/*comment*/",
    ]) {
      expect(() => validateTableSuffix(invalidPrefix)).toThrow(
        /letters, digits, or underscores/
      );
    }
  });

  test("builds checkpoint table names", () => {
    expect(getOracleCheckpointTables("lg")).toEqual({
      checkpoints: "CHECKPOINTS_LG",
      checkpoint_blobs: "CHECKPOINT_BLOBS_LG",
      checkpoint_writes: "CHECKPOINT_WRITES_LG",
      checkpoint_migrations: "CHECKPOINT_MIGRATIONS_LG",
    });

    // No suffix gives the bare names Python creates.
    expect(getOracleCheckpointTables()).toEqual({
      checkpoints: "CHECKPOINTS",
      checkpoint_blobs: "CHECKPOINT_BLOBS",
      checkpoint_writes: "CHECKPOINT_WRITES",
      checkpoint_migrations: "CHECKPOINT_MIGRATIONS",
    });

    // The suffix is used verbatim, so a trailing underscore is kept.
    expect(getOracleCheckpointTables("lg_").checkpoints).toBe(
      "CHECKPOINTS_LG_"
    );
  });

  test("uses the Python-compatible checkpoint migration history", () => {
    const migrations = getMigrations("");
    expect(migrations).toHaveLength(7);
    expect(migrations[1]).toContain("checkpoint JSON NOT NULL");
    expect(migrations[1]).toContain("metadata JSON DEFAULT '{}' NOT NULL");
    expect(migrations[3]).toContain("task_path VARCHAR2(2000) NOT NULL");
    expect(migrations[4]).toContain("CHECKPOINTS_THREAD_ID_IDX");
    expect(migrations[6]).toContain("CHECKPOINT_WRITES_THREAD_ID_IDX");
  });

  test("round-trips checkpoint namespaces without sentinel collisions", () => {
    const encoded = encodeCheckpointNamespace("");
    expect(encoded).toBe(" ");
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
    expect(() => encodeCheckpointNamespace(" ")).toThrow(
      "checkpoint_ns cannot be a single space"
    );
    expect(encodeTaskPath("")).toBe(" ");
    expect(() => encodeTaskPath(" ")).toThrow(
      "task_path cannot be a single space"
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

    expect(select.sql).toContain("FROM CHECKPOINTS_LG");
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

  test("builds bind-safe recursive checkpoint metadata filters", () => {
    const select = buildSelectCheckpointSQL({
      metadataFilter: {
        nested: { child: { enabled: true, score: 7 } },
        optional: null,
        emptyString: "",
        items: [2, { kind: "target" }],
        "literal.key'": "value",
      },
      limit: 2,
    });

    expect(select.sql).toContain("JSON_EXISTS(metadata");
    expect(select.sql).toContain('@."nested"."child"."enabled" == true');
    expect(select.sql).toContain(
      '@."optional".type() == "null" && @."optional" == null'
    );
    expect(select.sql).toContain(
      '@."emptyString".type() == "string" && @."emptyString" == ""'
    );
    expect(select.sql).toContain('@."items".type() == "array"');
    expect(select.sql).toContain('exists(@."items"[*]?(');
    expect(select.sql).toContain(`."literal.key''" == $F`);
    expect(select.sql).toContain("FETCH FIRST 2 ROWS ONLY");
    expect(select.binds).toEqual({
      metadata_filter_0: 7,
      metadata_filter_1: 2,
      metadata_filter_2: "target",
      metadata_filter_3: "value",
    });
    expect(select.sql).not.toContain("target");
    expect(select.sql).not.toContain("value");
  });

  test("rejects unsupported checkpoint metadata filter values", () => {
    expect(() =>
      buildCheckpointMetadataFilter({ value: undefined })
    ).toThrow('metadata filter at $["value"]');
    expect(() => buildCheckpointMetadataFilter({ value: new Date() })).toThrow(
      "objects must be plain objects"
    );
    expect(() =>
      buildCheckpointMetadataFilter({ value: Number.NaN })
    ).toThrow("numbers must be finite");
    expect(() =>
      buildCheckpointMetadataFilter({ value: "x".repeat(32768) })
    ).toThrow("strings must not exceed 32767 UTF-8 bytes");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buildCheckpointMetadataFilter(cyclic)).toThrow(
      "cyclic values are not supported"
    );

    expect(buildCheckpointMetadataFilter({})).toEqual({
      sql: "",
      binds: {},
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
