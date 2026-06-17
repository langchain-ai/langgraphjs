import { Buffer } from "node:buffer";

export const DEFAULT_TABLE_PREFIX = "LANGGRAPH_";
export const TASKS_CHANNEL = "__pregel_tasks";

const ORACLE_IDENTIFIER_MAX_LENGTH = 128;
const TABLE_SUFFIXES = [
  "CHECKPOINTS",
  "CHECKPOINT_BLOBS",
  "CHECKPOINT_WRITES",
  "CHECKPOINT_MIGRATIONS",
] as const;

const TABLE_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export type OracleCheckpointTableSuffix = (typeof TABLE_SUFFIXES)[number];

export interface OracleCheckpointTables {
  checkpoints: string;
  checkpoint_blobs: string;
  checkpoint_writes: string;
  checkpoint_migrations: string;
}

export type OracleBindPrimitive =
  | string
  | number
  | Uint8Array
  | null
  | undefined;

export type OracleBindParams = Record<string, OracleBindPrimitive>;

export type OracleSerializedCheckpoint = Record<string, unknown>;

export interface OracleParameterizedSQL {
  sql: string;
  binds: OracleBindParams;
}

export interface OracleSetupStatements {
  SELECT_LATEST_MIGRATION_SQL: string;
  INSERT_MIGRATION_SQL: string;
  LIST_TABLES_SQL: string;
  TABLE_EXISTS_SQL: string;
}

export interface OracleSQLStatements {
  SELECT_CHECKPOINT_SQL: string;
  SELECT_CHECKPOINT_BLOBS_SQL: string;
  SELECT_CHECKPOINT_WRITES_SQL: string;
  SELECT_PENDING_SENDS_SQL: string;
  UPSERT_CHECKPOINT_BLOBS_SQL: string;
  UPSERT_CHECKPOINTS_SQL: string;
  UPSERT_CHECKPOINT_WRITES_SQL: string;
  INSERT_CHECKPOINT_WRITES_SQL: string;
  DELETE_CHECKPOINTS_SQL: string;
  DELETE_CHECKPOINT_BLOBS_SQL: string;
  DELETE_CHECKPOINT_WRITES_SQL: string;
}

export type OracleSQLTypes = {
  SELECT_CHECKPOINT_SQL: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    parent_checkpoint_id: string | null;
    type: string | null;
    metadata_type: string | null;
    checkpoint: Uint8Array;
    metadata: Uint8Array;
  };
  SELECT_CHECKPOINT_BLOBS_SQL: {
    channel: string;
    type: string;
    blob: Uint8Array | null;
  };
  SELECT_CHECKPOINT_WRITES_SQL: {
    task_id: string;
    channel: string;
    type: string | null;
    blob: Uint8Array;
  };
  SELECT_PENDING_SENDS_SQL: {
    checkpoint_id: string;
    type: string | null;
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

export const encodeCheckpointNamespace = (
  checkpointNs?: string | null
): string => {
  const raw = checkpointNs ?? "";
  return `b64:${Buffer.from(raw, "utf8").toString("base64url")}`;
};

export const decodeCheckpointNamespace = (checkpointNs: string): string => {
  if (!checkpointNs.startsWith("b64:")) {
    return checkpointNs;
  }
  return Buffer.from(checkpointNs.slice(4), "base64url").toString("utf8");
};

export const validateTablePrefix = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): string => {
  if (tablePrefix === "") return tablePrefix;

  if (!TABLE_PREFIX_RE.test(tablePrefix)) {
    throw new Error(
      "Oracle checkpoint tablePrefix must start with a letter and contain only letters, numbers, or underscores."
    );
  }

  const normalizedPrefix = tablePrefix.toUpperCase();
  for (const suffix of TABLE_SUFFIXES) {
    const tableName = `${normalizedPrefix}${suffix}`;
    if (tableName.length > ORACLE_IDENTIFIER_MAX_LENGTH) {
      throw new Error(
        `Oracle checkpoint table name "${tableName}" exceeds ${ORACLE_IDENTIFIER_MAX_LENGTH} characters.`
      );
    }
  }

  return normalizedPrefix;
};

export const getOracleCheckpointTables = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleCheckpointTables => {
  const prefix = validateTablePrefix(tablePrefix);
  return {
    checkpoints: `${prefix}CHECKPOINTS`,
    checkpoint_blobs: `${prefix}CHECKPOINT_BLOBS`,
    checkpoint_writes: `${prefix}CHECKPOINT_WRITES`,
    checkpoint_migrations: `${prefix}CHECKPOINT_MIGRATIONS`,
  };
};

export const getTablesWithPrefix = getOracleCheckpointTables;

export const getOracleSetupStatements = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleSetupStatements => {
  const tables = getOracleCheckpointTables(tablePrefix);
  return {
    SELECT_LATEST_MIGRATION_SQL: `SELECT v
FROM ${tables.checkpoint_migrations}
ORDER BY v DESC
FETCH FIRST 1 ROW ONLY`,
    INSERT_MIGRATION_SQL: `INSERT INTO ${tables.checkpoint_migrations} (v)
VALUES (:version)`,
    LIST_TABLES_SQL: `SELECT table_name
FROM user_tables
WHERE table_name IN (
  UPPER(:checkpoints),
  UPPER(:checkpoint_blobs),
  UPPER(:checkpoint_writes),
  UPPER(:checkpoint_migrations)
)`,
    TABLE_EXISTS_SQL: `SELECT COUNT(*) AS table_count
FROM user_tables
WHERE table_name = UPPER(:table_name)`,
  };
};

export const tableExistsSQL = (): string =>
  `SELECT COUNT(*) AS table_count
FROM user_tables
WHERE table_name = UPPER(:table_name)`;

export const getListTablesParams = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleBindParams => ({ ...getOracleCheckpointTables(tablePrefix) });

export const getTableExistsParams = (
  tableName:
    | keyof OracleCheckpointTables
    | OracleCheckpointTableSuffix
    | string,
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleBindParams => {
  const tables = getOracleCheckpointTables(tablePrefix);
  const resolvedTableName =
    tableName in tables
      ? tables[tableName as keyof OracleCheckpointTables]
      : tableName;
  return { table_name: resolvedTableName };
};

export const getOracleSQLStatements = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleSQLStatements => {
  const tables = getOracleCheckpointTables(tablePrefix);

  return {
    SELECT_CHECKPOINT_SQL: `SELECT
  cp.thread_id,
  cp.checkpoint_ns,
  cp.checkpoint_id,
  cp.parent_checkpoint_id,
  cp.type,
  cp.metadata_type,
  cp.checkpoint,
  cp.metadata
FROM ${tables.checkpoints} cp `,

    SELECT_CHECKPOINT_BLOBS_SQL: `SELECT
  bl.channel,
  bl.type,
  bl.blob
FROM JSON_TABLE(
  :channel_versions_json,
  '$[*]' COLUMNS (
    channel VARCHAR2(4000) PATH '$.channel',
    version VARCHAR2(4000) PATH '$.version'
  )
) cv
INNER JOIN ${tables.checkpoint_blobs} bl
  ON bl.thread_id = :thread_id
  AND bl.checkpoint_ns = :checkpoint_ns
  AND bl.channel = cv.channel
  AND bl.version = cv.version
ORDER BY bl.channel`,

    SELECT_CHECKPOINT_WRITES_SQL: `SELECT
  cw.task_id,
  cw.channel,
  cw.type,
  cw.blob
FROM ${tables.checkpoint_writes} cw
WHERE cw.thread_id = :thread_id
  AND cw.checkpoint_ns = :checkpoint_ns
  AND cw.checkpoint_id = :checkpoint_id
ORDER BY cw.task_id, cw.idx`,

    SELECT_PENDING_SENDS_SQL: `SELECT
  cw.checkpoint_id,
  cw.type,
  cw.blob
FROM ${tables.checkpoint_writes} cw
WHERE cw.thread_id = :thread_id
  AND cw.checkpoint_ns = :checkpoint_ns
  AND cw.checkpoint_id IN (
    SELECT jt.checkpoint_id
    FROM JSON_TABLE(
      :checkpoint_ids_json,
      '$[*]' COLUMNS (checkpoint_id VARCHAR2(4000) PATH '$')
    ) jt
  )
  AND cw.channel = :tasks_channel
ORDER BY cw.checkpoint_id, cw.task_id, cw.idx`,

    UPSERT_CHECKPOINT_BLOBS_SQL: `MERGE INTO ${tables.checkpoint_blobs} dst
USING (
  SELECT
    :thread_id AS thread_id,
    :checkpoint_ns AS checkpoint_ns,
    :channel AS channel,
    :version AS version,
    :type AS type,
    :blob AS blob
  FROM dual
) src
ON (
  dst.thread_id = src.thread_id
  AND dst.checkpoint_ns = src.checkpoint_ns
  AND dst.channel = src.channel
  AND dst.version = src.version
)
WHEN NOT MATCHED THEN INSERT (
  thread_id,
  checkpoint_ns,
  channel,
  version,
  type,
  blob
) VALUES (
  src.thread_id,
  src.checkpoint_ns,
  src.channel,
  src.version,
  src.type,
  src.blob
)`,

    UPSERT_CHECKPOINTS_SQL: `MERGE INTO ${tables.checkpoints} dst
USING (
  SELECT
    :thread_id AS thread_id,
    :checkpoint_ns AS checkpoint_ns,
    :checkpoint_id AS checkpoint_id,
    :parent_checkpoint_id AS parent_checkpoint_id,
    :type AS type,
    :metadata_type AS metadata_type,
    :checkpoint AS checkpoint,
    :metadata AS metadata
  FROM dual
) src
ON (
  dst.thread_id = src.thread_id
  AND dst.checkpoint_ns = src.checkpoint_ns
  AND dst.checkpoint_id = src.checkpoint_id
)
WHEN MATCHED THEN UPDATE SET
  dst.parent_checkpoint_id = src.parent_checkpoint_id,
  dst.type = src.type,
  dst.metadata_type = src.metadata_type,
  dst.checkpoint = src.checkpoint,
  dst.metadata = src.metadata
WHEN NOT MATCHED THEN INSERT (
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  type,
  metadata_type,
  checkpoint,
  metadata
) VALUES (
  src.thread_id,
  src.checkpoint_ns,
  src.checkpoint_id,
  src.parent_checkpoint_id,
  src.type,
  src.metadata_type,
  src.checkpoint,
  src.metadata
)`,

    UPSERT_CHECKPOINT_WRITES_SQL: `MERGE INTO ${tables.checkpoint_writes} dst
USING (
  SELECT
    :thread_id AS thread_id,
    :checkpoint_ns AS checkpoint_ns,
    :checkpoint_id AS checkpoint_id,
    :task_id AS task_id,
    :idx AS idx,
    :channel AS channel,
    :type AS type,
    :blob AS blob
  FROM dual
) src
ON (
  dst.thread_id = src.thread_id
  AND dst.checkpoint_ns = src.checkpoint_ns
  AND dst.checkpoint_id = src.checkpoint_id
  AND dst.task_id = src.task_id
  AND dst.idx = src.idx
)
WHEN MATCHED THEN UPDATE SET
  dst.channel = src.channel,
  dst.type = src.type,
  dst.blob = src.blob
WHEN NOT MATCHED THEN INSERT (
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  task_id,
  idx,
  channel,
  type,
  blob
) VALUES (
  src.thread_id,
  src.checkpoint_ns,
  src.checkpoint_id,
  src.task_id,
  src.idx,
  src.channel,
  src.type,
  src.blob
)`,

    INSERT_CHECKPOINT_WRITES_SQL: `INSERT INTO ${tables.checkpoint_writes} (
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  task_id,
  idx,
  channel,
  type,
  blob
)
SELECT
  :thread_id,
  :checkpoint_ns,
  :checkpoint_id,
  :task_id,
  :idx,
  :channel,
  :type,
  :blob
FROM dual
WHERE NOT EXISTS (
  SELECT 1
  FROM ${tables.checkpoint_writes} existing
  WHERE existing.thread_id = :thread_id
    AND existing.checkpoint_ns = :checkpoint_ns
    AND existing.checkpoint_id = :checkpoint_id
    AND existing.task_id = :task_id
    AND existing.idx = :idx
)`,

    DELETE_CHECKPOINTS_SQL: `DELETE FROM ${tables.checkpoints}
WHERE thread_id = :thread_id`,
    DELETE_CHECKPOINT_BLOBS_SQL: `DELETE FROM ${tables.checkpoint_blobs}
WHERE thread_id = :thread_id`,
    DELETE_CHECKPOINT_WRITES_SQL: `DELETE FROM ${tables.checkpoint_writes}
WHERE thread_id = :thread_id`,
  };
};

export const getSQLStatements = getOracleSQLStatements;

const buildFetchFirstClause = (limit?: number): string => {
  if (limit === undefined) return "";

  const parsedLimit = Number.parseInt(limit.toString(), 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 0) {
    throw new Error(
      "Oracle checkpoint SELECT limit must be a non-negative integer."
    );
  }

  return ` FETCH FIRST ${parsedLimit} ROWS ONLY`;
};

export interface OracleSearchWhereInput {
  threadId?: string;
  checkpointNs?: string;
  checkpointId?: string;
  beforeCheckpointId?: string;
}

export const buildCheckpointWhereClause = (
  input: OracleSearchWhereInput
): OracleParameterizedSQL => {
  const wheres: string[] = [];
  const binds: OracleBindParams = {};

  if (input.threadId !== undefined) {
    wheres.push("thread_id = :thread_id");
    binds.thread_id = input.threadId;
  }

  if (input.checkpointNs !== undefined) {
    wheres.push("checkpoint_ns = :checkpoint_ns");
    binds.checkpoint_ns = encodeCheckpointNamespace(input.checkpointNs);
  }

  if (input.checkpointId !== undefined) {
    wheres.push("checkpoint_id = :checkpoint_id");
    binds.checkpoint_id = input.checkpointId;
  }

  if (input.beforeCheckpointId !== undefined) {
    wheres.push("checkpoint_id < :before_checkpoint_id");
    binds.before_checkpoint_id = input.beforeCheckpointId;
  }

  return {
    sql: wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "",
    binds,
  };
};

export const buildSelectCheckpointSQL = (
  input: OracleSearchWhereInput & { limit?: number },
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleParameterizedSQL => {
  const statements = getOracleSQLStatements(tablePrefix);
  const where = buildCheckpointWhereClause(input);
  const limit = buildFetchFirstClause(input.limit);

  return {
    sql: `${statements.SELECT_CHECKPOINT_SQL}${where.sql} ORDER BY checkpoint_id DESC${limit}`,
    binds: where.binds,
  };
};

export const getPendingSendsParams = (
  threadId: string,
  checkpointNs: string,
  checkpointIds: string[]
): OracleBindParams => ({
  thread_id: threadId,
  checkpoint_ns: encodeCheckpointNamespace(checkpointNs),
  checkpoint_ids_json: JSON.stringify(checkpointIds),
  tasks_channel: TASKS_CHANNEL,
});
