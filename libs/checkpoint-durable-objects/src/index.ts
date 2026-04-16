import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import type { SqlBackend } from "./backend.js";
import {
  CREATE_CHECKPOINTS_TABLE,
  CREATE_CHECKPOINT_BLOBS_TABLE,
  CREATE_CHANNEL_ITEMS_TABLE,
  CREATE_WRITES_TABLE,
} from "./schema.js";
import {
  type SegmentRecipe,
  computeRecipeForPut,
  totalItemCount,
} from "./segments.js";

export { type SqlBackend } from "./backend.js";
export { DurableObjectBackend } from "./backends/do.js";

// Metadata key validation (same pattern as SqliteSaver)
const checkpointMetadataKeys = ["source", "step", "parents"] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T,
]
  ? [keyof T] extends [K[number]]
    ? K
    : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>
): K {
  return keys;
}

const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: string;
  metadata: string;
}

interface BlobRow {
  channel: string;
  type: string;
  blob: string;
  version: string;
}

interface WriteRow {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendRow {
  type: string;
  blob: string;
}

/**
 * Internal checkpoint shape stored in the `checkpoint` BLOB column.
 * This is the standard Checkpoint minus `channel_values`, plus segment recipes.
 */
interface StoredCheckpoint {
  v: number;
  id: string;
  ts: string;
  channel_versions: Record<string, unknown>;
  versions_seen: Record<string, Record<string, unknown>>;
  channel_values?: Record<string, unknown>;
  list_channel_segments?: Record<string, SegmentRecipe>;
}

export interface DurableObjectSaverOptions {
  listChannels?: Set<string>;
}

export class DurableObjectSqliteSaver extends BaseCheckpointSaver {
  private backend: SqlBackend;
  private isSetup = false;
  private listChannels: Set<string>;

  constructor(
    backend: SqlBackend,
    options?: DurableObjectSaverOptions,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.backend = backend;
    this.listChannels = options?.listChannels ?? new Set();
  }

  private setup(): void {
    if (this.isSetup) return;
    this.backend.execute(CREATE_CHECKPOINTS_TABLE);
    this.backend.execute(CREATE_CHECKPOINT_BLOBS_TABLE);
    this.backend.execute(CREATE_CHANNEL_ITEMS_TABLE);
    this.backend.execute(CREATE_WRITES_TABLE);
    this.isSetup = true;
  }

  async getTuple(
    config: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    if (!thread_id) return undefined;

    // Load checkpoint row
    let row: CheckpointRow | undefined;
    if (checkpoint_id) {
      row = this.backend.queryOne<CheckpointRow>(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                type, checkpoint, metadata
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        thread_id,
        checkpoint_ns,
        checkpoint_id
      );
    } else {
      row = this.backend.queryOne<CheckpointRow>(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                type, checkpoint, metadata
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC LIMIT 1`,
        thread_id,
        checkpoint_ns
      );
    }

    if (!row) return undefined;

    const effectiveCheckpointId = row.checkpoint_id;
    const effectiveConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns ?? "",
        checkpoint_id: effectiveCheckpointId,
      },
    };

    // Deserialize checkpoint blob
    const storedCheckpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as StoredCheckpoint;

    // Reconstruct channel_values
    const channelValues: Record<string, unknown> = {};

    // Inline primitive values from stored checkpoint
    if (storedCheckpoint.channel_values) {
      Object.assign(channelValues, storedCheckpoint.channel_values);
    }

    // Load blob channel values
    const channelVersions = storedCheckpoint.channel_versions ?? {};
    for (const [channel, version] of Object.entries(channelVersions)) {
      if (channel in channelValues) continue; // already inline

      if (
        this.listChannels.has(channel) &&
        storedCheckpoint.list_channel_segments?.[channel]
      ) {
        // Reconstruct list from segments
        channelValues[channel] = await this.reconstructList(
          row.thread_id,
          row.checkpoint_ns ?? "",
          channel,
          storedCheckpoint.list_channel_segments[channel]
        );
      } else {
        // Load from checkpoint_blobs
        const blobRow = this.backend.queryOne<BlobRow>(
          `SELECT type, blob FROM checkpoint_blobs
           WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?`,
          row.thread_id,
          row.checkpoint_ns ?? "",
          channel,
          String(version)
        );
        if (blobRow && blobRow.type !== "empty") {
          channelValues[channel] = await this.serde.loadsTyped(
            blobRow.type,
            blobRow.blob ?? ""
          );
        }
      }
    }

    // Build full checkpoint
    const checkpoint: Checkpoint = {
      v: storedCheckpoint.v,
      id: storedCheckpoint.id,
      ts: storedCheckpoint.ts,
      channel_values: channelValues,
      channel_versions: storedCheckpoint.channel_versions as Record<
        string,
        number | string
      >,
      versions_seen: storedCheckpoint.versions_seen as Record<
        string,
        Record<string, number | string>
      >,
    };

    // Handle v<4 pending sends migration
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.checkpoint_ns ?? "",
        row.parent_checkpoint_id
      );
    }

    // Load pending writes
    const writeRows = this.backend.queryAll<WriteRow>(
      `SELECT task_id, channel, type, value FROM writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       ORDER BY task_id, idx`,
      row.thread_id,
      row.checkpoint_ns ?? "",
      effectiveCheckpointId
    );

    const pendingWrites = await Promise.all(
      writeRows.map(async (w) => {
        return [
          w.task_id,
          w.channel,
          await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
        ] as [string, string, unknown];
      })
    );

    // Deserialize metadata
    const metadata = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.metadata
    )) as CheckpointMetadata;

    return {
      checkpoint,
      config: effectiveConfig,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns ?? "",
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let sql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                      type, checkpoint, metadata
               FROM checkpoints\n`;

    const whereClause: string[] = [];
    const args: unknown[] = [];

    if (thread_id) {
      whereClause.push("thread_id = ?");
      args.push(thread_id);
    }
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push("checkpoint_ns = ?");
      args.push(checkpoint_ns);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push("checkpoint_id < ?");
      args.push(before.configurable.checkpoint_id);
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(
            key as keyof CheckpointMetadata
          )
      )
    );

    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`
      )
    );
    args.push(
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value))
    );

    if (whereClause.length > 0) {
      sql += `WHERE ${whereClause.join(" AND ")}\n`;
    }

    sql += "ORDER BY checkpoint_id DESC";

    if (limit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql += ` LIMIT ${parseInt(limit as any, 10)}`;
    }

    const rows = this.backend.queryAll<CheckpointRow>(sql, ...args);

    for (const row of rows) {
      const innerConfig: RunnableConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns ?? "",
          checkpoint_id: row.checkpoint_id,
        },
      };

      const tuple = await this.getTuple(innerConfig);
      if (tuple) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        'Missing "thread_id" field in passed "config.configurable".'
      );
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);

    const storedCheckpoint: StoredCheckpoint = {
      v: preparedCheckpoint.v!,
      id: preparedCheckpoint.id!,
      ts: preparedCheckpoint.ts!,
      channel_versions:
        preparedCheckpoint.channel_versions as Record<string, unknown>,
      versions_seen:
        preparedCheckpoint.versions_seen as Record<
          string,
          Record<string, unknown>
        >,
    };

    // --- Phase 1: Async prep (reads, serde, append verification) ---

    let parentSegments: Record<string, SegmentRecipe> = {};
    if (parent_checkpoint_id) {
      const parentRow = this.backend.queryOne<{
        type: string;
        checkpoint: string;
      }>(
        `SELECT type, checkpoint FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        thread_id,
        checkpoint_ns,
        parent_checkpoint_id
      );
      if (parentRow) {
        const parentStored = (await this.serde.loadsTyped(
          parentRow.type ?? "json",
          parentRow.checkpoint
        )) as StoredCheckpoint;
        parentSegments = parentStored.list_channel_segments ?? {};
      }
    }

    let parentHasChildren = false;
    if (parent_checkpoint_id) {
      const childRow = this.backend.queryOne(
        `SELECT 1 as found FROM checkpoints
         WHERE parent_checkpoint_id = ? AND thread_id = ? AND checkpoint_ns = ?
         LIMIT 1`,
        parent_checkpoint_id,
        thread_id,
        checkpoint_ns
      );
      parentHasChildren = childRow !== undefined;
    }

    // Pre-compute segment recipes and serialize items (all async)
    const channelValues = checkpoint.channel_values ?? {};
    const listChannelSegments: Record<string, SegmentRecipe> = {};

    // Items to write: { channel, segmentId, idx, type, blob }[]
    const pendingItems: {
      channel: string;
      segmentId: string;
      idx: number;
      type: string;
      blob: Uint8Array;
    }[] = [];

    // Blobs to write: { channel, version, type, blob }[]
    const pendingBlobs: {
      channel: string;
      version: string;
      type: string;
      blob: Uint8Array;
    }[] = [];

    for (const [channel, version] of Object.entries(newVersions)) {
      const value = channelValues[channel];

      if (this.listChannels.has(channel) && Array.isArray(value)) {
        const parentRecipe = parentSegments[channel] ?? [];
        const parentCount = totalItemCount(parentRecipe);

        // Verify this is a true append by checking only the last parent item
        let isVerifiedAppend = false;
        if (value.length >= parentCount && parentCount > 0) {
          const lastSegment = parentRecipe[parentRecipe.length - 1];
          if (lastSegment && lastSegment.end > 0) {
            const lastItemRow = this.backend.queryOne<{
              type: string;
              blob: string;
            }>(
              `SELECT type, blob FROM channel_items
               WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ?
                 AND segment_id = ? AND idx = ?`,
              thread_id,
              checkpoint_ns,
              channel,
              lastSegment.sid,
              lastSegment.end - 1
            );
            if (lastItemRow) {
              const lastParentItem = await this.serde.loadsTyped(
                lastItemRow.type,
                lastItemRow.blob ?? ""
              );
              isVerifiedAppend =
                JSON.stringify(lastParentItem) ===
                JSON.stringify(value[parentCount - 1]);
            }
          }
        } else if (parentCount === 0) {
          isVerifiedAppend = true;
        }

        const { recipe, newItemsStart, segmentId } = computeRecipeForPut(
          parentRecipe,
          value.length,
          parentHasChildren,
          isVerifiedAppend
        );

        listChannelSegments[channel] = recipe;

        const itemsToWrite = value.slice(newItemsStart);
        const lastRef = recipe[recipe.length - 1];
        const segStartIdx = lastRef
          ? lastRef.end - itemsToWrite.length
          : 0;

        for (let i = 0; i < itemsToWrite.length; i++) {
          const [itemType, itemBlob] = await this.serde.dumpsTyped(
            itemsToWrite[i]
          );
          pendingItems.push({
            channel,
            segmentId,
            idx: segStartIdx + i,
            type: itemType,
            blob: itemBlob,
          });
        }
      } else {
        const [blobType, blobValue] = await this.serde.dumpsTyped(value);
        pendingBlobs.push({
          channel,
          version: String(version),
          type: blobType,
          blob: blobValue,
        });
      }
    }

    // Carry forward parent recipes for unchanged list channels
    for (const channel of this.listChannels) {
      if (!(channel in newVersions) && parentSegments[channel]) {
        listChannelSegments[channel] = parentSegments[channel];
      }
    }

    if (Object.keys(listChannelSegments).length > 0) {
      storedCheckpoint.list_channel_segments = listChannelSegments;
    }

    // Serialize checkpoint and metadata
    const [cpType, cpBlob] = await this.serde.dumpsTyped(storedCheckpoint);
    const [, mdBlob] = await this.serde.dumpsTyped(metadata);

    // --- Phase 2: Sync transaction (all writes) ---

    this.backend.transaction(() => {
      for (const item of pendingItems) {
        this.backend.execute(
          `INSERT OR IGNORE INTO channel_items
           (thread_id, checkpoint_ns, channel, segment_id, idx, type, blob)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          thread_id,
          checkpoint_ns,
          item.channel,
          item.segmentId,
          item.idx,
          item.type,
          item.blob
        );
      }

      for (const blob of pendingBlobs) {
        this.backend.execute(
          `INSERT OR IGNORE INTO checkpoint_blobs
           (thread_id, checkpoint_ns, channel, version, type, blob)
           VALUES (?, ?, ?, ?, ?, ?)`,
          thread_id,
          checkpoint_ns,
          blob.channel,
          blob.version,
          blob.type,
          blob.blob
        );
      }

      this.backend.execute(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id ?? null,
        cpType,
        cpBlob,
        mdBlob
      );
    });

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const checkpoint_id = config.configurable.checkpoint_id;

    const serializedWrites = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, blob] = await this.serde.dumpsTyped(value);
        return { channel, type, blob, idx };
      })
    );

    this.backend.transaction(() => {
      for (const { channel, type, blob, idx } of serializedWrites) {
        this.backend.execute(
          `INSERT OR REPLACE INTO writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          taskId,
          idx,
          channel,
          type,
          blob
        );
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.backend.transaction(() => {
      this.backend.execute(
        "DELETE FROM checkpoints WHERE thread_id = ?",
        threadId
      );
      this.backend.execute(
        "DELETE FROM checkpoint_blobs WHERE thread_id = ?",
        threadId
      );
      this.backend.execute(
        "DELETE FROM channel_items WHERE thread_id = ?",
        threadId
      );
      this.backend.execute(
        "DELETE FROM writes WHERE thread_id = ?",
        threadId
      );
    });
  }

  private async reconstructList(
    threadId: string,
    checkpointNs: string,
    channel: string,
    recipe: SegmentRecipe
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (const { sid, end } of recipe) {
      const rows = this.backend.queryAll<{ type: string; blob: string }>(
        `SELECT type, blob FROM channel_items
         WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND segment_id = ? AND idx < ?
         ORDER BY idx ASC`,
        threadId,
        checkpointNs,
        channel,
        sid,
        end
      );
      for (const row of rows) {
        items.push(
          await this.serde.loadsTyped(row.type ?? "json", row.blob ?? "")
        );
      }
    }
    return items;
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<void> {
    const rows = this.backend.queryAll<PendingSendRow>(
      `SELECT type, value as blob FROM writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = '${TASKS}'
       ORDER BY task_id, idx`,
      threadId,
      checkpointNs,
      parentCheckpointId
    );

    if (rows.length === 0) return;

    const mutableCheckpoint = checkpoint;
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      rows.map(({ type, blob }) =>
        this.serde.loadsTyped(type ?? "json", blob ?? "")
      )
    );

    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
