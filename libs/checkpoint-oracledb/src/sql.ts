// Copyright (c) 2026, Oracle and/or its affiliates.
import { TASKS } from "@langchain/langgraph-checkpoint";
import { Buffer } from "node:buffer";

import { suffixedTableName, validateTableSuffix } from "./identifiers.js";

export { validateTableSuffix };
const JSON_PATH_MAX_BYTES = 32767;
const JSON_PASSING_STRING_MAX_BYTES = 32767;

export interface OracleCheckpointTables {
  checkpoints: string;
  checkpoint_blobs: string;
  checkpoint_writes: string;
  checkpoint_migrations: string;
}

export type OracleBindParams = Record<string, unknown>;

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

const encodeNotNullText = (value: string | null | undefined, label: string) => {
  const raw = value ?? "";
  if (raw === " ") {
    throw new Error(
      `Oracle checkpoint ${label} cannot be a single space because that value is reserved for empty strings.`
    );
  }
  return raw === "" ? " " : raw;
};

export const encodeCheckpointNamespace = (
  checkpointNs?: string | null
): string => encodeNotNullText(checkpointNs, "checkpoint_ns");

export const encodeTaskPath = (taskPath?: string | null): string =>
  encodeNotNullText(taskPath, "task_path");

export const decodeCheckpointNamespace = (checkpointNs: string): string => {
  return checkpointNs === " " ? "" : checkpointNs;
};

/**
 * Checkpoint table names for a suffix.
 *
 * With no suffix these are the bare names Python creates, so both languages
 * resolve to the same tables by default. Every name goes through
 * {@link suffixedTableName}, which yields an unquoted upper-case identifier.
 */
export const getOracleCheckpointTables = (
  tableSuffix: string = ""
): OracleCheckpointTables => ({
  checkpoints: suffixedTableName("CHECKPOINTS", tableSuffix),
  checkpoint_blobs: suffixedTableName("CHECKPOINT_BLOBS", tableSuffix),
  checkpoint_writes: suffixedTableName("CHECKPOINT_WRITES", tableSuffix),
  checkpoint_migrations: suffixedTableName(
    "CHECKPOINT_MIGRATIONS",
    tableSuffix
  ),
});

export const getOracleSetupStatements = (
  tableSuffix: string = ""
): OracleSetupStatements => {
  const tables = getOracleCheckpointTables(tableSuffix);
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

export const getOracleSQLStatements = (
  tableSuffix: string = ""
): OracleSQLStatements => {
  const tables = getOracleCheckpointTables(tableSuffix);

  return {
    SELECT_CHECKPOINT_SQL: `SELECT
  cp.thread_id,
  cp.checkpoint_ns,
  cp.checkpoint_id,
  cp.parent_checkpoint_id,
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
ORDER BY cw.checkpoint_id, cw.task_path, cw.task_id, cw.idx`,

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
  dst.checkpoint = src.checkpoint,
  dst.metadata = src.metadata
WHEN NOT MATCHED THEN INSERT (
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  checkpoint,
  metadata
) VALUES (
  src.thread_id,
  src.checkpoint_ns,
  src.checkpoint_id,
  src.parent_checkpoint_id,
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
    :task_path AS task_path,
    :idx AS idx,
    :channel AS channel,
    :type AS type,
    COALESCE(:blob, EMPTY_BLOB()) AS blob
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
  task_path,
  idx,
  channel,
  type,
  blob
) VALUES (
  src.thread_id,
  src.checkpoint_ns,
  src.checkpoint_id,
  src.task_id,
  src.task_path,
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
  task_path,
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
  :task_path,
  :idx,
  :channel,
  :type,
  COALESCE(:blob, EMPTY_BLOB())
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

const buildFetchFirstClause = (limit?: number): string => {
  if (limit === undefined) return "";

  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "Oracle checkpoint SELECT limit must be a non-negative integer."
    );
  }

  return ` FETCH FIRST ${limit} ROWS ONLY`;
};

export interface OracleSearchWhereInput {
  threadId?: string;
  checkpointNs?: string;
  checkpointId?: string;
  beforeCheckpointId?: string;
  metadataFilter?: Record<string, unknown>;
}

const unsupportedMetadataFilter = (path: string, reason: string): never => {
  throw new Error(
    `Unsupported Oracle checkpoint metadata filter at ${path}: ${reason}.`
  );
};

const metadataFilterPath = (path: string, key: string): string =>
  `${path}[${JSON.stringify(key)}]`;

const jsonPathMember = (key: string): string => `.${JSON.stringify(key)}`;

const isObjectPredicate = (subject: string): string =>
  ["array", "string", "number", "boolean", "null"]
    .map((type) => `!(${subject}.type() == "${type}")`)
    .join(" && ");

type MetadataFilterCompiler = {
  binds: OracleBindParams;
  passing: string[];
  nextBind: number;
};

const compileMetadataFilterValue = (
  compiler: MetadataFilterCompiler,
  subject: string,
  value: unknown,
  path: string,
  ancestors: Set<object>
): string => {
  if (value === null) {
    return `${subject}.type() == "null" && ${subject} == null`;
  }

  if (typeof value === "boolean") {
    return `${subject}.type() == "boolean" && ${subject} == ${
      value ? "true" : "false"
    }`;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return unsupportedMetadataFilter(path, "numbers must be finite");
    }
    const bindIndex = compiler.nextBind++;
    const bindName = `metadata_filter_${bindIndex}`;
    const variableName = `F${bindIndex}`;
    compiler.binds[bindName] = value;
    compiler.passing.push(`:${bindName} AS "${variableName}"`);
    return `${subject}.type() == "number" && ${subject} == $${variableName}`;
  }

  if (typeof value === "string") {
    if (value === "") {
      return `${subject}.type() == "string" && ${subject} == ""`;
    }
    if (Buffer.byteLength(value, "utf8") > JSON_PASSING_STRING_MAX_BYTES) {
      return unsupportedMetadataFilter(
        path,
        `strings must not exceed ${JSON_PASSING_STRING_MAX_BYTES} UTF-8 bytes`
      );
    }
    const bindIndex = compiler.nextBind++;
    const bindName = `metadata_filter_${bindIndex}`;
    const variableName = `F${bindIndex}`;
    compiler.binds[bindName] = value;
    compiler.passing.push(`:${bindName} AS "${variableName}"`);
    return `${subject}.type() == "string" && ${subject} == $${variableName}`;
  }

  if (typeof value !== "object") {
    return unsupportedMetadataFilter(path, "values must be plain JSON values");
  }

  if (ancestors.has(value)) {
    return unsupportedMetadataFilter(path, "cyclic values are not supported");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        Reflect.ownKeys(value).length !== value.length + 1 ||
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        return unsupportedMetadataFilter(
          path,
          "arrays must be dense and contain no custom properties"
        );
      }

      const predicates = [`${subject}.type() == "array"`];
      value.forEach((item, index) => {
        const itemPredicate = compileMetadataFilterValue(
          compiler,
          "@",
          item,
          `${path}[${index}]`,
          ancestors
        );
        predicates.push(`exists(${subject}[*]?(${itemPredicate}))`);
      });
      return predicates.join(" && ");
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupportedMetadataFilter(path, "objects must be plain objects");
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      return unsupportedMetadataFilter(
        path,
        "objects must contain only enumerable string properties"
      );
    }

    const predicates = [
      ...(subject === "@" ? [] : [`exists(${subject})`]),
      isObjectPredicate(subject),
    ];
    for (const [key, item] of Object.entries(value)) {
      const member = `${subject}${jsonPathMember(key)}`;
      predicates.push(
        compileMetadataFilterValue(
          compiler,
          member,
          item,
          metadataFilterPath(path, key),
          ancestors
        )
      );
    }
    return predicates.join(" && ");
  } finally {
    ancestors.delete(value);
  }
};

export const buildCheckpointMetadataFilter = (
  filter: Record<string, unknown>
): OracleParameterizedSQL => {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return unsupportedMetadataFilter("$", "the filter must be a plain object");
  }

  const compiler: MetadataFilterCompiler = {
    binds: {},
    passing: [],
    nextBind: 0,
  };
  const predicate = compileMetadataFilterValue(
    compiler,
    "@",
    filter,
    "$",
    new Set()
  );
  if (Object.keys(filter).length === 0) {
    return { sql: "", binds: {} };
  }
  const jsonPath = `$?(${predicate})`;
  if (Buffer.byteLength(jsonPath, "utf8") > JSON_PATH_MAX_BYTES) {
    return unsupportedMetadataFilter(
      "$",
      `the compiled JSON path must not exceed ${JSON_PATH_MAX_BYTES} UTF-8 bytes`
    );
  }

  const escapedPath = jsonPath.replaceAll("'", "''");
  const passing =
    compiler.passing.length > 0
      ? ` PASSING ${compiler.passing.join(", ")}`
      : "";
  return {
    sql: `JSON_EXISTS(metadata, '${escapedPath}'${passing})`,
    binds: compiler.binds,
  };
};

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

  if (input.metadataFilter !== undefined) {
    const metadataFilter = buildCheckpointMetadataFilter(input.metadataFilter);
    if (metadataFilter.sql) wheres.push(metadataFilter.sql);
    Object.assign(binds, metadataFilter.binds);
  }

  return {
    sql: wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "",
    binds,
  };
};

export const buildSelectCheckpointSQL = (
  input: OracleSearchWhereInput & { limit?: number },
  tableSuffix: string = ""
): OracleParameterizedSQL => {
  const statements = getOracleSQLStatements(tableSuffix);
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
  tasks_channel: TASKS,
});
