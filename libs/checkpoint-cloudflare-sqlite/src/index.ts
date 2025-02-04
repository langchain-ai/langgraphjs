import { SqlStorage } from '@cloudflare/workers-types';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  copyCheckpoint,
} from '@langchain/langgraph-checkpoint';

interface CheckpointRow {
  checkpoint: string;
  metadata: string;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
  pending_writes: string;
  pending_sends: string;
}

interface PendingWriteColumn {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendColumn {
  type: string;
  value: string;
}

export class CloudflareDurableObjectSqliteSaver extends BaseCheckpointSaver {
  db: SqlStorage;

  protected isSetup: boolean;

  constructor(db: SqlStorage, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  protected async setup(): Promise<void> {
    if (this.isSetup) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      
      CREATE TABLE IF NOT EXISTS writes (
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
    `);

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {};

    const sql = `
      SELECT
        c.*,
        (
          SELECT json_group_array(
            json_object(
              'task_id', w.task_id,
              'channel', w.channel,
              'type', w.type,
              'value', w.value
            )
          )
          FROM writes w
          WHERE w.thread_id = c.thread_id
            AND w.checkpoint_ns = c.checkpoint_ns
            AND w.checkpoint_id = c.checkpoint_id
        ) as pending_writes,
        (
          SELECT json_group_array(
            json_object(
              'type', ps.type,
              'value', ps.value
            )
          )
          FROM writes ps
          WHERE ps.thread_id = c.thread_id
            AND ps.checkpoint_ns = c.checkpoint_ns
            AND ps.checkpoint_id = c.parent_checkpoint_id
            AND ps.channel = 'tasks'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints c
      WHERE c.thread_id = ?1 
      AND c.checkpoint_ns = ?2
      ${checkpoint_id ? 'AND c.checkpoint_id = ?3' : ''}
      ORDER BY c.checkpoint_id DESC
      LIMIT 1
    `;

    const params = [thread_id, checkpoint_ns];
    if (checkpoint_id) params.push(checkpoint_id);

    const cursor = this.db.exec(sql, ...params);
    const row = cursor.next()?.value as unknown as CheckpointRow;

    if (!row) return undefined;

    let finalConfig = config;
    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error('Missing thread_id or checkpoint_id');
    }

    const pendingWrites = await Promise.all(
      (() => {
        try {
          return JSON.parse(String(row.pending_writes || '[]')) as PendingWriteColumn[];
        } catch (e) {
          console.error('Failed to parse pending writes:', e);
          return [];
        }
      })().map(async (write) => {
        return [
          write.task_id,
          write.channel,
          await this.serde.loadsTyped(write.type ?? 'json', write.value ?? ''),
        ] as [string, string, unknown];
      })
    );

    const pending_sends = await Promise.all(
      (() => {
        try {
          return JSON.parse(String(row.pending_sends || '[]')) as PendingSendColumn[];
        } catch (e) {
          console.error('Failed to parse pending sends:', e);
          return [];
        }
      })().map(async (send) => await this.serde.loadsTyped(send.type ?? 'json', send.value ?? ''))
    );

    const checkpoint = {
      ...(await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)),
      pending_sends,
    } as Checkpoint;

    return {
      checkpoint,
      config: finalConfig,
      metadata: await this.serde.loadsTyped(row.type ?? 'json', row.metadata),
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  // Example of modified write method
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.setup();

    if (!config.configurable) {
      throw new Error('Empty configuration supplied.');
    }

    if (!config.configurable?.thread_id) {
      throw new Error('Missing thread_id field in config.configurable.');
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error('Missing checkpoint_id field in config.configurable.');
    }

    // Process writes sequentially since Cloudflare SQLite doesn't support transactions
    for (const [idx, write] of writes.entries()) {
      const [type, serializedWrite] = this.serde.dumpsTyped(write[1]);

      this.db.exec(
        `INSERT OR REPLACE INTO writes 
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) 
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        config.configurable.thread_id,
        config.configurable.checkpoint_ns ?? '',
        config.configurable.checkpoint_id,
        taskId,
        idx,
        write[0],
        type,
        serializedWrite
      );
    }
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.setup();
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';

    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pw.task_id,
              'channel', pw.channel,
              'type', pw.type,
              'value', CAST(pw.value AS TEXT)
            )
          )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes
      FROM checkpoints
    `;

    const whereClause: string[] = [];
    const params: (string | number)[] = [];

    if (thread_id) {
      whereClause.push('thread_id = ?');
      params.push(thread_id);
    }

    if (checkpoint_ns !== undefined) {
      whereClause.push('checkpoint_ns = ?');
      params.push(checkpoint_ns);
    }

    if (before?.configurable?.checkpoint_id) {
      whereClause.push('checkpoint_id < ?');
      params.push(before.configurable.checkpoint_id);
    }

    if (filter) {
      const sanitizedFilter = Object.entries(filter).filter(([key]) =>
        ['source', 'step', 'writes', 'parents'].includes(key)
      );

      for (const [key, value] of sanitizedFilter) {
        whereClause.push(`json_extract(metadata, '$.${key}') = ?`);
        params.push(JSON.stringify(value));
      }
    }

    if (whereClause.length > 0) {
      sql += ` WHERE ${whereClause.join(' AND ')}`;
    }

    sql += ' ORDER BY checkpoint_id DESC';

    if (limit) {
      sql += ` LIMIT ${parseInt(String(limit), 10)}`;
    }

    const cursor = this.db.exec(sql, ...params);
    const rows = Array.from(cursor, (row) => row.value as unknown as CheckpointRow);

    for (const row of rows) {
      const pendingWrites = await Promise.all(
        (JSON.parse(String(row.pending_writes || '[]')) as PendingWriteColumn[]).map(
          async (write) => {
            return [
              write.task_id,
              write.channel,
              await this.serde.loadsTyped(write.type ?? 'json', write.value ?? ''),
            ] as [string, string, unknown];
          }
        )
      );

      const checkpoint = await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint);

      yield {
        checkpoint,
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        metadata: await this.serde.loadsTyped(row.type ?? 'json', row.metadata),
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites,
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await this.setup();

    if (!config.configurable) {
      throw new Error('Empty configuration supplied.');
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(`Missing "thread_id" field in passed "config.configurable".`);
    }

    // Create a copy of the checkpoint without pending_sends
    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
    delete preparedCheckpoint.pending_sends;

    const [type1, serializedCheckpoint] = this.serde.dumpsTyped(preparedCheckpoint);
    const [type2, serializedMetadata] = this.serde.dumpsTyped(metadata);

    if (type1 !== type2) {
      throw new Error('Failed to serialized checkpoint and metadata to the same type.');
    }

    this.db.exec(
      `INSERT OR REPLACE INTO checkpoints 
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) 
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id,
      type1,
      serializedCheckpoint,
      serializedMetadata
    );

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }
}
