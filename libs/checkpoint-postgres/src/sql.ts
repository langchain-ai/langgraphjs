import { TASKS } from "@langchain/langgraph-checkpoint";

export interface SQL_STATEMENTS {
  SELECT_SQL: string;
  UPSERT_CHECKPOINT_BLOBS_SQL: string;
  UPSERT_CHECKPOINTS_SQL: string;
  UPSERT_CHECKPOINT_WRITES_SQL: string;
  INSERT_CHECKPOINT_WRITES_SQL: string;
}

export const getSQLStatements = (schema: string): SQL_STATEMENTS => ({
  SELECT_SQL: 
`select
  thread_id,
  checkpoint,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  metadata,
  (
    select array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob])
    from jsonb_each_text(checkpoint -> 'channel_versions')
    inner join ${schema}.checkpoint_blobs bl
      on bl.thread_id = cp.thread_id
      and bl.checkpoint_ns = cp.checkpoint_ns
      and bl.channel = jsonb_each_text.key
      and bl.version = jsonb_each_text.value
  ) as channel_values,
  (
    select
    array_agg(array[cw.task_id::text::bytea, cw.channel::bytea, cw.type::bytea, cw.blob] order by cw.task_id, cw.idx)
    from ${schema}.checkpoint_writes cw
    where cw.thread_id = cp.thread_id
      and cw.checkpoint_ns = cp.checkpoint_ns
      and cw.checkpoint_id = cp.checkpoint_id
  ) as pending_writes,
  (
    select array_agg(array[cw.type::bytea, cw.blob] order by cw.idx)
    from ${schema}.checkpoint_writes cw
    where cw.thread_id = cp.thread_id
      and cw.checkpoint_ns = cp.checkpoint_ns
      and cw.checkpoint_id = cp.parent_checkpoint_id
      and cw.channel = '${TASKS}'
  ) as pending_sends
from ${schema}.checkpoints cp `, // <-- the trailing space is necessary for combining with WHERE clauses

  UPSERT_CHECKPOINT_BLOBS_SQL: 
`INSERT INTO ${schema}.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (thread_id, checkpoint_ns, channel, version) DO NOTHING
`,

  UPSERT_CHECKPOINTS_SQL: 
`INSERT INTO ${schema}.checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
DO UPDATE SET
  checkpoint = EXCLUDED.checkpoint,
  metadata = EXCLUDED.metadata;
`,

  UPSERT_CHECKPOINT_WRITES_SQL: 
`INSERT INTO ${schema}.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
  channel = EXCLUDED.channel,
  type = EXCLUDED.type,
  blob = EXCLUDED.blob;
`,

  INSERT_CHECKPOINT_WRITES_SQL: 
`INSERT INTO ${schema}.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING
`,
});