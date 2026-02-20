import { describe, it, expect } from "vitest";
import {
  getTablesWithSchema,
  getSQLStatements,
  tableExistsSQL,
} from "../sql.js";
import { getStoreTablesWithSchema } from "../store/sql.js";
import { getMigrations } from "../migrations.js";
import { getStoreMigrations } from "../store/store-migrations.js";

describe("getTablesWithSchema", () => {
  it("should quote the schema identifier for simple schemas", () => {
    const tables = getTablesWithSchema("public");
    expect(tables.checkpoints).toBe('"public".checkpoints');
    expect(tables.checkpoint_blobs).toBe('"public".checkpoint_blobs');
    expect(tables.checkpoint_writes).toBe('"public".checkpoint_writes');
    expect(tables.checkpoint_migrations).toBe('"public".checkpoint_migrations');
  });

  it("should quote schemas with dashes", () => {
    const tables = getTablesWithSchema("my-schema");
    expect(tables.checkpoints).toBe('"my-schema".checkpoints');
    expect(tables.checkpoint_blobs).toBe('"my-schema".checkpoint_blobs');
    expect(tables.checkpoint_writes).toBe('"my-schema".checkpoint_writes');
    expect(tables.checkpoint_migrations).toBe(
      '"my-schema".checkpoint_migrations'
    );
  });

  it("should quote schemas with special characters", () => {
    const tables = getTablesWithSchema("my schema");
    expect(tables.checkpoints).toBe('"my schema".checkpoints');
  });
});

describe("getStoreTablesWithSchema", () => {
  it("should quote the schema identifier for simple schemas", () => {
    const tables = getStoreTablesWithSchema("public");
    expect(tables.store).toBe('"public".store');
    expect(tables.store_vectors).toBe('"public".store_vectors');
    expect(tables.store_migrations).toBe('"public".store_migrations');
  });

  it("should quote schemas with dashes", () => {
    const tables = getStoreTablesWithSchema("my-schema");
    expect(tables.store).toBe('"my-schema".store');
    expect(tables.store_vectors).toBe('"my-schema".store_vectors');
    expect(tables.store_migrations).toBe('"my-schema".store_migrations');
  });
});

describe("getSQLStatements", () => {
  it("should produce valid SQL with a dashed schema", () => {
    const statements = getSQLStatements("my-schema");

    // All SQL statements should contain the quoted schema
    expect(statements.SELECT_SQL).toContain('"my-schema".checkpoint_blobs');
    expect(statements.SELECT_SQL).toContain('"my-schema".checkpoint_writes');
    expect(statements.SELECT_SQL).toContain('"my-schema".checkpoints');

    expect(statements.SELECT_PENDING_SENDS_SQL).toContain(
      '"my-schema".checkpoint_writes'
    );

    expect(statements.UPSERT_CHECKPOINT_BLOBS_SQL).toContain(
      '"my-schema".checkpoint_blobs'
    );
    expect(statements.UPSERT_CHECKPOINTS_SQL).toContain(
      '"my-schema".checkpoints'
    );
    expect(statements.UPSERT_CHECKPOINT_WRITES_SQL).toContain(
      '"my-schema".checkpoint_writes'
    );
    expect(statements.INSERT_CHECKPOINT_WRITES_SQL).toContain(
      '"my-schema".checkpoint_writes'
    );

    expect(statements.DELETE_CHECKPOINTS_SQL).toContain(
      '"my-schema".checkpoints'
    );
    expect(statements.DELETE_CHECKPOINT_BLOBS_SQL).toContain(
      '"my-schema".checkpoint_blobs'
    );
    expect(statements.DELETE_CHECKPOINT_WRITES_SQL).toContain(
      '"my-schema".checkpoint_writes'
    );
  });

  it("should not contain unquoted dashed schema references", () => {
    const statements = getSQLStatements("my-schema");
    const allSql = Object.values(statements).join("\n");

    // Should not contain unquoted "my-schema." (without surrounding double quotes)
    expect(allSql).not.toMatch(/(?<!")my-schema\./);
  });
});

describe("getMigrations", () => {
  it("should produce valid migration SQL with a dashed schema", () => {
    const migrations = getMigrations("my-schema");

    for (const migration of migrations) {
      // Every table reference should use the quoted schema
      expect(migration).not.toMatch(/(?<!")my-schema\./);
    }

    expect(migrations[0]).toContain('"my-schema".checkpoint_migrations');
    expect(migrations[1]).toContain('"my-schema".checkpoints');
    expect(migrations[2]).toContain('"my-schema".checkpoint_blobs');
    expect(migrations[3]).toContain('"my-schema".checkpoint_writes');
    expect(migrations[4]).toContain('"my-schema".checkpoint_blobs');
  });
});

describe("getStoreMigrations", () => {
  it("should produce valid migration SQL with a dashed schema", () => {
    const migrations = getStoreMigrations({ schema: "my-schema" });

    for (const migration of migrations) {
      // Every schema reference should be quoted
      expect(migration).not.toMatch(/(?<!")my-schema\./);
    }

    expect(migrations[0]).toContain('"my-schema".store_migrations');
    expect(migrations[1]).toContain('"my-schema".store');
    expect(migrations[2]).toContain('"my-schema".store');
    // Migration 3 has the function and trigger
    expect(migrations[3]).toContain('"my-schema".update_updated_at_column()');
    expect(migrations[3]).toContain('"my-schema".store');
  });
});

describe("tableExistsSQL", () => {
  it("should use schema as a string value in WHERE clause", () => {
    const sql = tableExistsSQL("my-schema", "my-schema.checkpoints");
    // In the WHERE clause the schema is a string value, not an identifier,
    // so it should use single quotes (not double quotes)
    expect(sql).toContain("table_schema = 'my-schema'");
    expect(sql).toContain("table_name   = 'checkpoints'");
  });
});
