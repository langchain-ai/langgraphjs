import { type Checkpoint, TASKS } from "@langchain/langgraph-checkpoint";

export interface SQL_STATEMENTS {
  SELECT_SQL: string;
  SELECT_PENDING_SENDS_SQL: string;
  SELECT_BLOBS_SQL: string;
  SELECT_WRITES_SQL: string;
  UPSERT_CHECKPOINT_BLOBS_SQL: string;
  UPSERT_CHECKPOINTS_SQL: string;
  UPSERT_CHECKPOINT_WRITES_SQL: string;
  INSERT_CHECKPOINT_WRITES_SQL: string;
  DELETE_CHECKPOINTS_SQL: string;
  DELETE_CHECKPOINT_BLOBS_SQL: string;
  DELETE_CHECKPOINT_WRITES_SQL: string;
}

export type SQL_TYPES = {
  SELECT_SQL: {
    channel_values: [Uint8Array, Uint8Array, Uint8Array][];
    checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">;
    parent_checkpoint_id: string | null;
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    metadata: Record<string, unknown>;
    pending_writes: [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ][];
  };
  SELECT_PENDING_SENDS_SQL: {
    checkpoint_id: string;
    type: string;
    blob: Uint8Array;
  };
  UPSERT_CHECKPOINT_BLOBS_SQL: unknown;
  UPSERT_CHECKPOINTS_SQL: unknown;
  UPSERT_CHECKPOINT_WRITES_SQL: unknown;
  INSERT_CHECKPOINT_WRITES_SQL: unknown;
  DELETE_CHECKPOINTS_SQL: unknown;
  DELETE_CHECKPOINT_BLOBS_SQL: unknown;
  DELETE_CHECKPOINT_WRITES_SQL: unknown;
};

interface TABLES {
  checkpoints: string;
  checkpoint_blobs: string;
  checkpoint_writes: string;
  checkpoint_migrations: string;
}

export const getTablesWithSchema = (schema: string): TABLES => {
  const tables = [
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_migrations",
    "checkpoint_writes",
  ];
  return tables.reduce((acc, table) => {
    acc[table as keyof TABLES] = `"${schema}".${table}`;
    return acc;
  }, {} as TABLES);
};

export const getSQLStatements = (schema: string): SQL_STATEMENTS => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  return {
    SELECT_SQL: `select
    thread_id,
    checkpoint,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    metadata
  from ${SCHEMA_TABLES.checkpoints} cp `,

    SELECT_BLOBS_SQL: `select bl.channel, bl.type, bl.blob
    from jsonb_each_text($3::jsonb) versions,
      ${SCHEMA_TABLES.checkpoint_blobs} bl
    where bl.thread_id = $1 and bl.checkpoint_ns = $2
      and bl.channel = versions.key and bl.version = versions.value`,

    SELECT_WRITES_SQL: `select task_id, channel, type, blob, task_path, idx
    from ${SCHEMA_TABLES.checkpoint_writes}
    where thread_id = $1 and checkpoint_ns = $2 and checkpoint_id = $3`,

    SELECT_PENDING_SENDS_SQL: `select checkpoint_id, type, blob
    from ${SCHEMA_TABLES.checkpoint_writes}
    where thread_id = $1
      and checkpoint_id = any($2)
      and channel = '${TASKS}'
    order by task_path, task_id, idx
  `,

    UPSERT_CHECKPOINT_BLOBS_SQL: `INSERT INTO ${SCHEMA_TABLES.checkpoint_blobs} (thread_id, checkpoint_ns, channel, version, type, blob)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (thread_id, checkpoint_ns, channel, version) DO NOTHING
  `,

    UPSERT_CHECKPOINTS_SQL: `INSERT INTO ${SCHEMA_TABLES.checkpoints} (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
  DO UPDATE SET
    checkpoint = EXCLUDED.checkpoint,
    metadata = EXCLUDED.metadata;
  `,

    UPSERT_CHECKPOINT_WRITES_SQL: `INSERT INTO ${SCHEMA_TABLES.checkpoint_writes} (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, blob)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
    channel = EXCLUDED.channel,
    type = EXCLUDED.type,
    blob = EXCLUDED.blob;
  `,

    INSERT_CHECKPOINT_WRITES_SQL: `INSERT INTO ${SCHEMA_TABLES.checkpoint_writes} (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, blob)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING
  `,

    DELETE_CHECKPOINTS_SQL: `DELETE FROM ${SCHEMA_TABLES.checkpoints} WHERE thread_id = $1`,
    DELETE_CHECKPOINT_BLOBS_SQL: `DELETE FROM ${SCHEMA_TABLES.checkpoint_blobs} WHERE thread_id = $1`,
    DELETE_CHECKPOINT_WRITES_SQL: `DELETE FROM ${SCHEMA_TABLES.checkpoint_writes} WHERE thread_id = $1`,
  };
};

export const tableExistsSQL = (schema: string, table: string) => {
  const tableWithoutSchema = table.split(".")[1];
  return `SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE  table_schema = '${schema}'
  AND    table_name   = '${tableWithoutSchema}'
  );`;
};
