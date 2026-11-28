import { type Checkpoint, TASKS } from "@langchain/langgraph-checkpoint";

export interface SQL_STATEMENTS {
  SELECT_SQL: string;
  SELECT_PENDING_SENDS_SQL: string;
  UPSERT_CHECKPOINT_BLOBS_SQL: string;
  UPSERT_CHECKPOINTS_SQL: string;
  UPSERT_CHECKPOINT_WRITES_SQL: string;
  INSERT_CHECKPOINT_WRITES_SQL: string;
  DELETE_CHECKPOINTS_SQL: string;
  DELETE_CHECKPOINT_BLOBS_SQL: string;
  DELETE_CHECKPOINT_WRITES_SQL: string;
  INSERT_CHECKPOINT_WRITES_BATCH_SQL: (rows: number) => string;
  UPSERT_CHECKPOINT_WITH_BLOBS_SQL: (blobs: number) => string;
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
    pending_sends: [Uint8Array, Uint8Array][];
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

/** The most rows one batch statement takes: Postgres allows 65,535 parameters. */
export const MAX_BATCH_ROWS = 16_000;

/** `rows` VALUES tuples: the `shared` parameters, then four of its own each. */
const batchValues = (rows: number, shared: string, first: number) =>
  Array.from({ length: rows }, (_, i) => {
    const p = first + i * 4;
    return `(${shared}, $${p}, $${p + 1}, $${p + 2}, $${p + 3})`;
  }).join(", ");

export const getSQLStatements = (schema: string): SQL_STATEMENTS => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  return {
    SELECT_SQL: `select
    thread_id,
    checkpoint,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    metadata,
    (
      select array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob])
      from jsonb_each_text(checkpoint -> 'channel_versions')
      inner join ${SCHEMA_TABLES.checkpoint_blobs} bl
        on bl.thread_id = cp.thread_id
        and bl.checkpoint_ns = cp.checkpoint_ns
        and bl.channel = jsonb_each_text.key
        and bl.version = jsonb_each_text.value
    ) as channel_values,
    (
      select
      array_agg(array[cw.task_id::text::bytea, cw.channel::bytea, cw.type::bytea, cw.blob, convert_to(cw.task_path, 'UTF8'), cw.idx::text::bytea])
      from ${SCHEMA_TABLES.checkpoint_writes} cw
      where cw.thread_id = cp.thread_id
        and cw.checkpoint_ns = cp.checkpoint_ns
        and cw.checkpoint_id = cp.checkpoint_id
    ) as pending_writes
  from ${SCHEMA_TABLES.checkpoints} cp `, // <-- the trailing space is necessary for combining with WHERE clauses

    SELECT_PENDING_SENDS_SQL: `select
      checkpoint_id,
      array_agg(array[cw.type::bytea, cw.blob] order by cw.task_path, cw.task_id, cw.idx) as pending_sends
    from ${SCHEMA_TABLES.checkpoint_writes} cw
    where cw.thread_id = $1
      and cw.checkpoint_id = any($2)
      and cw.channel = '${TASKS}'
    group by cw.checkpoint_id
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

    // Rows go in order, so of two with the same key the first is kept, as
    // with one statement per row.
    INSERT_CHECKPOINT_WRITES_BATCH_SQL: (rows) =>
      `INSERT INTO ${SCHEMA_TABLES.checkpoint_writes} (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, blob)
  VALUES ${batchValues(rows, "$1, $2, $3, $4, $5", 6)}
  ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING`,

    // The blobs and the checkpoint in one statement, which is atomic alone.
    UPSERT_CHECKPOINT_WITH_BLOBS_SQL: (blobs) =>
      `WITH blobs AS (
    INSERT INTO ${SCHEMA_TABLES.checkpoint_blobs} (thread_id, checkpoint_ns, channel, version, type, blob)
    VALUES ${batchValues(blobs, "$1, $2", 7)}
    ON CONFLICT (thread_id, checkpoint_ns, channel, version) DO NOTHING
  )
  INSERT INTO ${SCHEMA_TABLES.checkpoints} (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
  DO UPDATE SET
    checkpoint = EXCLUDED.checkpoint,
    metadata = EXCLUDED.metadata`,
  };
};

/** What `PostgresSaver.prune` can do to a thread. */
export const PRUNE_STRATEGIES = ["keep_latest", "delete"] as const;

export type PruneStrategy = (typeof PRUNE_STRATEGIES)[number];

/**
 * The statements of `PostgresSaver.prune`, ported from langgraph (Python)'s
 * `PRUNE_*_SQL`.
 *
 * None of them joins two sets of a thread's rows: a join is planned from
 * per-thread row estimates, which are worst for the few huge threads worth
 * pruning, and can go quadratic. They look rows up by primary key instead
 * (`LATERAL ... LIMIT 1`, `= ANY`).
 */
export const getPruneSQLStatements = (schema: string) => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  return {
    /** `$1`: the thread ids. */
    DELETE_THREADS_SQL: [
      `DELETE FROM ${SCHEMA_TABLES.checkpoints} WHERE thread_id = ANY($1)`,
      `DELETE FROM ${SCHEMA_TABLES.checkpoint_blobs} WHERE thread_id = ANY($1)`,
      `DELETE FROM ${SCHEMA_TABLES.checkpoint_writes} WHERE thread_id = ANY($1)`,
    ],

    /**
     * `$1`: the thread ids. A `DeltaChannel` leaves update counters in
     * checkpoint metadata, or a snapshot: an inline `true` marker with a blob
     * behind it, which a plain `true` value never has. LangGraph.js inlines no
     * values, but marks the threads its `DeltaChannel` graphs start with
     * `delta_writes_versioned`.
     */
    DELTA_THREADS_SQL: `SELECT thread_id FROM ${SCHEMA_TABLES.checkpoints}
  WHERE thread_id = ANY($1) AND (
    metadata ? 'counters_since_delta_snapshot'
    OR metadata ? 'delta_writes_versioned'
  )
  UNION
  SELECT c.thread_id
  FROM ${SCHEMA_TABLES.checkpoints} c
  CROSS JOIN LATERAL jsonb_each(c.checkpoint -> 'channel_values') AS v
  CROSS JOIN LATERAL (
    SELECT 1 FROM ${SCHEMA_TABLES.checkpoint_blobs} b
    WHERE b.thread_id = c.thread_id
    AND b.checkpoint_ns = c.checkpoint_ns
    AND b.channel = v.key
    AND b.version = c.checkpoint -> 'channel_versions' ->> v.key
    LIMIT 1
  ) AS snapshot
  WHERE c.thread_id = ANY($1) AND v.value = 'true'::jsonb`,

    /**
     * `$1`: the thread id. Per namespace: the latest checkpoint, the parent it
     * reads its pending sends from when it predates v4, and the root graph's
     * checkpoint its subgraph call started from, with whether that one is saved.
     */
    HEADS_SQL: `SELECT
    h.checkpoint_ns,
    h.checkpoint_id AS head,
    CASE WHEN (c.checkpoint ->> 'v')::int < 4 AND EXISTS (
      SELECT 1 FROM ${SCHEMA_TABLES.checkpoint_writes} w
      WHERE w.thread_id = $1
      AND w.checkpoint_ns = h.checkpoint_ns
      AND w.checkpoint_id = c.parent_checkpoint_id
      AND w.channel = '${TASKS}'
    ) THEN c.parent_checkpoint_id END AS sends_parent,
    c.metadata -> 'parents' ->> '' AS root,
    EXISTS (
      SELECT 1 FROM ${SCHEMA_TABLES.checkpoints} r
      WHERE r.thread_id = $1 AND r.checkpoint_ns = ''
      AND r.checkpoint_id = c.metadata -> 'parents' ->> ''
    ) AS root_saved
  FROM (
    SELECT DISTINCT ON (checkpoint_ns) checkpoint_ns, checkpoint_id
    FROM ${SCHEMA_TABLES.checkpoints}
    WHERE thread_id = $1
    ORDER BY checkpoint_ns DESC, checkpoint_id DESC
  ) AS h
  CROSS JOIN LATERAL (
    SELECT checkpoint, parent_checkpoint_id, metadata FROM ${SCHEMA_TABLES.checkpoints}
    WHERE thread_id = $1
    AND checkpoint_ns = h.checkpoint_ns
    AND checkpoint_id = h.checkpoint_id
  ) AS c`,

    /** `$1`: the thread id, `$2`: the namespace, `$3`: the checkpoint ids to keep. */
    UNKEPT_SQL: `SELECT checkpoint_id FROM ${SCHEMA_TABLES.checkpoints}
  WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id <> ALL($3)`,

    /**
     * `$1`: the thread id, `$2`: the namespace, `$3`: the checkpoint ids deleted.
     * A run saves a superstep's writes in the background, where they can commit
     * before their checkpoint does, so they go by the checkpoints deleted.
     */
    WRITES_SQL: `DELETE FROM ${SCHEMA_TABLES.checkpoint_writes}
  WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = ANY($3)`,

    /**
     * `$1`: the thread id, `$2`: the namespace, `$3`: the checkpoint ids to
     * keep. Returns the channel versions the deleted checkpoints used.
     */
    CHECKPOINTS_SQL: `WITH deleted AS (
    DELETE FROM ${SCHEMA_TABLES.checkpoints}
    WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id <> ALL($3)
    RETURNING checkpoint -> 'channel_versions' AS versions
  )
  SELECT DISTINCT v.key AS channel, v.value AS version
  FROM deleted
  CROSS JOIN LATERAL jsonb_each_text(deleted.versions) AS v`,

    /**
     * `$1`: the thread id, `$2`: the namespace, `$3`: the checkpoint ids kept,
     * `$4`: the same ids, to compare each parent against.
     */
    PARENTS_SQL: `UPDATE ${SCHEMA_TABLES.checkpoints} SET parent_checkpoint_id = NULL
  WHERE thread_id = $1 AND checkpoint_ns = $2
  AND checkpoint_id = ANY($3) AND parent_checkpoint_id <> ALL($4)`,

    /** `$1`: the thread id, `$2`: the namespace. */
    REFERENCED_BLOBS_SQL: `SELECT DISTINCT v.key AS channel, v.value AS version
  FROM ${SCHEMA_TABLES.checkpoints} c
  CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') AS v
  WHERE c.thread_id = $1 AND c.checkpoint_ns = $2`,

    /** `$1`: the thread id, `$2`: the namespace, `$3`: the channel, `$4`: the versions. */
    BLOBS_SQL: `DELETE FROM ${SCHEMA_TABLES.checkpoint_blobs}
  WHERE thread_id = $1 AND checkpoint_ns = $2 AND channel = $3 AND version = ANY($4)`,

    /** `$1`: the thread id, `$2`: the namespaces of the subgraph calls. */
    SUBGRAPH_CALLS_SQL: [
      `DELETE FROM ${SCHEMA_TABLES.checkpoints} WHERE thread_id = $1 AND checkpoint_ns = ANY($2)`,
      `DELETE FROM ${SCHEMA_TABLES.checkpoint_writes} WHERE thread_id = $1 AND checkpoint_ns = ANY($2)`,
      `DELETE FROM ${SCHEMA_TABLES.checkpoint_blobs} WHERE thread_id = $1 AND checkpoint_ns = ANY($2)`,
    ],
  };
};

export type DeltaStage1Row = {
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
} & Record<`ver_${number}`, string | null> &
  Record<`hb_${number}`, boolean>;

export type DeltaStage2Row =
  | {
      _kind: "w";
      checkpoint_id: string;
      channel: string;
      type: string;
      blob: Uint8Array;
      task_id: string;
      task_path: string;
      idx: number;
    }
  | { _kind: "b"; channel: string; type: string; blob: Uint8Array };

/**
 * Stage 1 of `PostgresSaver.getDeltaChannelHistory`, as Python's
 * `_build_delta_stage1_sql`: one page of the thread's checkpoints, newest
 * first, with each requested channel's version (`ver_i`) and whether a blob
 * is stored at that version (`hb_i`). Parameters: the k channel names, then
 * the thread id, namespace, cursor and page size.
 *
 * Pages run from the target down. The first page passes the target as the
 * cursor with `includeCursor`, so it opens with the target's own row, whose
 * parent starts the walk; each later page continues below the oldest row
 * read. A checkpoint's ancestors normally have smaller ids (uuid6 is
 * time-ordered, which `getTuple` also relies on to find the latest
 * checkpoint), so pages skip rows newer than the target; when an ancestor
 * sorts above it, `getDeltaChannelHistory` falls back to the base walk.
 */
export const getDeltaStage1SQL = (
  schema: string,
  channelCount: number,
  includeCursor = false
): string => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  const cols = Array.from(
    { length: channelCount },
    (_, i) => `checkpoint -> 'channel_versions' ->> $${i + 1}::text AS ver_${i},
      EXISTS (SELECT 1 FROM ${SCHEMA_TABLES.checkpoint_blobs} b${i}
        WHERE b${i}.thread_id = checkpoints.thread_id
          AND b${i}.checkpoint_ns = checkpoints.checkpoint_ns
          AND b${i}.channel = $${i + 1}::text
          AND b${i}.version = checkpoint -> 'channel_versions' ->> $${i + 1}::text
          AND b${i}.type <> 'empty') AS hb_${i}`
  );
  const [thread, ns, cursor, limit] = [1, 2, 3, 4].map(
    (i) => `$${channelCount + i}`
  );
  return `SELECT checkpoint_id, parent_checkpoint_id, ${cols.join(", ")}
    FROM ${SCHEMA_TABLES.checkpoints} checkpoints
    WHERE thread_id = ${thread} AND checkpoint_ns = ${ns}
      AND checkpoint_id ${includeCursor ? "<=" : "<"} ${cursor}
    ORDER BY checkpoint_id DESC LIMIT ${limit}`;
};

/**
 * Stage 2 of `PostgresSaver.getDeltaChannelHistory`, as Python's
 * `_build_delta_stage2_sql`: a `w` branch per channel with a chain, reading
 * its writes on those checkpoints, then a `b` branch per seeded channel,
 * reading its seed's blob. Parameters: the thread id and namespace, then the
 * channel and its chain for each `w` branch, then the channel and its seed
 * version for each `b` branch.
 */
export const getDeltaStage2SQL = (
  schema: string,
  chainCount: number,
  seedCount: number
): string => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  const writes = Array.from(
    { length: chainCount },
    (_, i) => `SELECT 'w'::text AS _kind, checkpoint_id, channel, type, blob,
        task_id, task_path, idx
      FROM ${SCHEMA_TABLES.checkpoint_writes}
      WHERE thread_id = $1 AND checkpoint_ns = $2
        AND channel = $${3 + 2 * i} AND checkpoint_id = ANY($${4 + 2 * i})`
  );
  const seeds = Array.from({ length: seedCount }, (_, i) => {
    const param = 3 + 2 * (chainCount + i);
    return `SELECT 'b'::text AS _kind, NULL::text AS checkpoint_id, channel,
        type, blob, NULL::text AS task_id, NULL::text AS task_path,
        NULL::integer AS idx
      FROM ${SCHEMA_TABLES.checkpoint_blobs}
      WHERE thread_id = $1 AND checkpoint_ns = $2
        AND channel = $${param} AND version = $${param + 1}`;
  });
  return [...writes, ...seeds].join(" UNION ALL ");
};

export const tableExistsSQL = (schema: string, table: string) => {
  const tableWithoutSchema = table.split(".")[1];
  return `SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE  table_schema = '${schema}'
  AND    table_name   = '${tableWithoutSchema}'
  );`;
};
