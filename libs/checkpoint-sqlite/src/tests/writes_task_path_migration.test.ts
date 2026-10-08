import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Checkpoint,
  emptyCheckpoint,
} from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "../index.js";

/**
 * Port of Python's test_writes_task_path_migration.py (langgraph #8544):
 * databases created before the `task_path` column must keep working —
 * migrated in place when writable, read with empty paths when read-only —
 * and setup must be repeatable (sqlite has no ADD COLUMN IF NOT EXISTS).
 */

const WRITES_BEFORE_TASK_PATH = `
CREATE TABLE writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
INSERT INTO writes VALUES ('t', '', 'c', 'old-task', 0, 'ch', 'json', X'227622');
`;

function legacyDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lg-sqlite-migration-"));
  const db = join(dir, `${name}.sqlite`);
  const conn = new Database(db);
  conn.exec(WRITES_BEFORE_TASK_PATH);
  conn.close();
  return db;
}

/** A brand-new empty database — no `writes` table until `setup()` runs. */
function freshDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lg-sqlite-migration-"));
  return join(dir, `${name}.sqlite`);
}

/** `setup()` is protected; expose it so the migration tests can run it
 * directly and repeatedly. */
class SetupSqliteSaver extends SqliteSaver {
  setupPublic(): void {
    this.setup();
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteSaver task_path migration", () => {
  it("setup migrates a legacy writes table, repeatably", () => {
    const db = legacyDbPath("legacy");
    dirs.push(db);
    for (let i = 0; i < 2; i += 1) {
      const saver = new SetupSqliteSaver(new Database(db));
      saver.setupPublic();
      const rows = saver.db
        .prepare("SELECT task_id, task_path FROM writes")
        .all() as Array<{ task_id: string; task_path: string }>;
      expect(rows).toEqual([{ task_id: "old-task", task_path: "" }]);
      saver.db.close();
    }
  });

  it.each([
    { fresh: true, label: "fresh database" },
    { fresh: false, label: "legacy database" },
  ])("putWrites persists the task path ($label)", async ({ fresh }) => {
    const db = fresh ? freshDbPath("fresh") : legacyDbPath("legacy2");
    dirs.push(db);
    const saver = SqliteSaver.fromConnString(db);
    const config = await saver.put(
      { configurable: { thread_id: "t", checkpoint_ns: "" } },
      emptyCheckpoint(),
      { source: "loop", step: 0, parents: {} }
    );
    await saver.putWrites(config, [["ch", "v"]], "task-1", "~__pregel_pull, node");
    const stored = saver.db
      .prepare("SELECT task_path FROM writes WHERE task_id = 'task-1'")
      .all() as Array<{ task_path: string }>;
    expect(stored).toEqual([{ task_path: "~__pregel_pull, node" }]);
    saver.db.close();
  });

  it("a read-only legacy database still reads delta history", async () => {
    // Build a thread with a delta-channel write, then drop the column to
    // emulate a database written before it existed.
    const db = legacyDbPath("readonly");
    dirs.push(db);
    const saver = SqliteSaver.fromConnString(db);
    const root: Checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { ch: "seed" },
      channel_versions: { ch: 1 },
    };
    const rootConfig = await saver.put(
      { configurable: { thread_id: "t", checkpoint_ns: "" } },
      root,
      { source: "loop", step: 0, parents: {} }
    );
    await saver.putWrites(
      rootConfig,
      [["ch", "write"]],
      "task",
      "~__pregel_pull, n"
    );
    const child = await saver.put(
      rootConfig,
      emptyCheckpoint(),
      { source: "loop", step: 1, parents: {} }
    );
    saver.db.exec("ALTER TABLE writes DROP COLUMN task_path");
    saver.db.close();

    chmodSync(db, 0o444);
    const ro = new Database(db, { readonly: true });
    const roSaver = new SqliteSaver(ro);
    const got = await roSaver.getDeltaChannelHistory({
      config: child,
      channels: ["ch"],
    });

    // Old rows have no path, so they keep their task-id order; the history
    // walk still reads them (with "" paths) instead of failing setup.
    expect(got.ch?.seed).toBe("seed");
    expect(got.ch?.writes).toEqual([["task", "ch", "write"]]);
    ro.close();
  });

  it("setup on an already-migrated database does not wait on a held write lock", () => {
    // sqlite has no ADD COLUMN IF NOT EXISTS, so setup() always runs the
    // ALTER and treats "duplicate column name" as success. That error is
    // raised while the statement is prepared — before sqlite asks for the
    // write lock — so setup on an up-to-date database must not block (or
    // fail on SQLITE_BUSY) while another connection holds the lock. No busy
    // timeout on either connection, to make any waiting fail loudly.
    const db = legacyDbPath("held-lock");
    dirs.push(db);
    // Migrate first, with a throwaway saver.
    const migrator = new SetupSqliteSaver(new Database(db));
    migrator.setupPublic();
    migrator.db.close();

    // A FRESH saver instance (so the `isSetup` fast path cannot skip setup)
    // while another connection holds the write lock with no busy timeout.
    const lockHolder = new Database(db);
    lockHolder.pragma("busy_timeout = 0");
    const saver = new SetupSqliteSaver(new Database(db));
    (saver.db as Database.Database).pragma("busy_timeout = 0");
    lockHolder.exec("BEGIN IMMEDIATE");
    try {
      // Must not throw (SQLITE_BUSY) or hang: the duplicate-column error
      // surfaces while sqlite prepares the ALTER, before it asks for the
      // write lock.
      saver.setupPublic();
      const rows = saver.db
        .prepare("SELECT task_id, task_path FROM writes")
        .all() as Array<{ task_id: string; task_path: string }>;
      expect(rows).toEqual([{ task_id: "old-task", task_path: "" }]);
    } finally {
      lockHolder.exec("ROLLBACK");
      lockHolder.close();
      saver.db.close();
    }
  });
});
