import { getTablesWithSchema } from "./sql.js";

/**
 * To add a new migration, add a new string to the list returned by the getMigrations function.
 * The position of the migration in the list is the version number.
 */
export const getMigrations = (schema: string) => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  return [
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_migrations} (
    v INTEGER PRIMARY KEY
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoints} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_blobs} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_writes} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_blobs} ALTER COLUMN blob DROP not null;`,
    // Migration 5: no-op (version alignment with Python)
    `SELECT 1;`,
    // Migration 6: index on checkpoints.thread_id
    `CREATE INDEX IF NOT EXISTS checkpoints_thread_id_idx ON ${SCHEMA_TABLES.checkpoints}(thread_id);`,
    // Migration 7: index on checkpoint_blobs.thread_id
    `CREATE INDEX IF NOT EXISTS checkpoint_blobs_thread_id_idx ON ${SCHEMA_TABLES.checkpoint_blobs}(thread_id);`,
    // Migration 8: index on checkpoint_writes.thread_id
    `CREATE INDEX IF NOT EXISTS checkpoint_writes_thread_id_idx ON ${SCHEMA_TABLES.checkpoint_writes}(thread_id);`,
    // Migration 9: add task_path column
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_writes} ADD COLUMN IF NOT EXISTS task_path TEXT NOT NULL DEFAULT '';`,
  ];
};
