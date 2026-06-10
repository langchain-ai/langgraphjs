import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointTuple,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  WRITES_IDX_MAP,
} from "./base.js";
import { SerializerProtocol } from "./serde/base.js";
import {
  CheckpointMetadata,
  CheckpointPendingWrite,
  DeltaChannelHistory,
  PendingWrite,
} from "./types.js";
import { TASKS } from "./serde/types.js";

/**
 * Keys that, when written into a plain JavaScript object via bracket
 * notation, traverse the prototype chain and mutate `Object.prototype`
 * (or the constructor) instead of creating a new own property. Any of
 * the three reaches `Object.prototype` and pollutes every object in
 * the running process. CWE-1321 (Prototype Pollution).
 */
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Asserts that a value sourced from {@link RunnableConfig.configurable} (or
 * any other caller-influenced position) is safe to use as a property key
 * on the in-memory checkpoint store.
 *
 * `MemorySaver` keeps state in two nested plain objects (`storage` and
 * `writes`) and writes to them with bracket notation:
 *
 *     this.storage[threadId][checkpointNamespace][checkpoint.id] = ...
 *
 * Without this guard a `threadId` of `"__proto__"` (or `"constructor"`)
 * resolves through the prototype chain, and the subsequent assignment
 * mutates `Object.prototype`. From that point every plain object in the
 * process inherits the injected property: `for...in` loops over unrelated
 * objects iterate it, framework code that does `if (obj[x])` short-circuits
 * unexpectedly, and downstream serializers may emit it. In a Node.js
 * server this is a stepping stone to remote code execution.
 *
 * `MemorySaver` is the default saver used by every quickstart, every
 * tutorial, and most test fixtures, so this guard runs in the hot path
 * for the most common LangGraph configuration.
 *
 * @param field Name of the configurable field, used in the error message.
 * @param value Value to validate. Must be a non-empty string that is not
 *              one of the three prototype-pollution keys.
 * @param options.allowEmpty When true the empty string is accepted, used
 *                            for the documented empty `checkpoint_ns`
 *                            default; otherwise an empty string is
 *                            rejected the same way as a non-string.
 */
function assertSafeStorageKey(
  field: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): asserts value is string {
  const { allowEmpty = false } = options;
  if (typeof value !== "string") {
    const observed =
      value === null
        ? "null"
        : value === undefined
          ? "undefined"
          : Array.isArray(value)
            ? "array"
            : typeof value;
    throw new Error(
      `Invalid configurable value for key "${field}": expected a string identifier (got ${observed}). This guard protects MemorySaver from prototype pollution.`
    );
  }
  if (!allowEmpty && value === "") {
    throw new Error(
      `Invalid configurable value for key "${field}": empty string is not permitted as an in-memory storage key.`
    );
  }
  if (POLLUTION_KEYS.has(value)) {
    throw new Error(
      `Invalid configurable value for key "${field}": value "${value}" is reserved (would mutate Object.prototype). This guard protects MemorySaver from prototype pollution.`
    );
  }
}

function _generateKey(
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string
) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

function _parseKey(key: string) {
  const [threadId, checkpointNamespace, checkpointId] = JSON.parse(key);
  return { threadId, checkpointNamespace, checkpointId };
}

export class MemorySaver extends BaseCheckpointSaver {
  // thread ID ->  checkpoint namespace -> checkpoint ID -> checkpoint mapping
  //
  // Defense in depth against prototype pollution: the backing
  // objects (and every nested level created below) use a null prototype, so
  // even if a malicious key bypassed `assertSafeStorageKey` it could not reach
  // `Object.prototype`. The guard remains the primary control; this is the
  // structural safety net.
  storage: Record<
    string,
    Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>
  > = Object.create(null);

  writes: Record<string, Record<string, [string, string, Uint8Array]>> =
    Object.create(null);

  constructor(serde?: SerializerProtocol) {
    super(serde);
  }

  /** @internal */
  async _migratePendingSends(
    mutableCheckpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ) {
    const deseriablizableCheckpoint = mutableCheckpoint;
    const parentKey = _generateKey(threadId, checkpointNs, parentCheckpointId);

    const pendingSends = await Promise.all(
      Object.values(this.writes[parentKey] ?? {})
        .filter(([_taskId, channel]) => channel === TASKS)
        .map(
          async ([_taskId, _channel, writes]) =>
            await this.serde.loadsTyped("json", writes)
        )
    );

    deseriablizableCheckpoint.channel_values ??= {};
    deseriablizableCheckpoint.channel_values[TASKS] = pendingSends;

    deseriablizableCheckpoint.channel_versions ??= {};
    deseriablizableCheckpoint.channel_versions[TASKS] =
      Object.keys(deseriablizableCheckpoint.channel_versions).length > 0
        ? maxChannelVersion(
            ...Object.values(deseriablizableCheckpoint.channel_versions)
          )
        : this.getNextVersion(undefined);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    let checkpoint_id = getCheckpointId(config);

    // Defense in depth: every public entry that mutates state already
    // validates these, but read paths must not return data sourced from
    // prototype-chain lookups when an attacker passes the magic keys.
    // `checkpoint_id` is intentionally allowed to be empty / undefined
    // here because the downstream `if (checkpoint_id)` branch treats
    // both as "fetch the latest checkpoint" rather than as a lookup key.
    if (thread_id !== undefined) {
      assertSafeStorageKey("thread_id", thread_id);
    }
    assertSafeStorageKey("checkpoint_ns", checkpoint_ns, { allowEmpty: true });
    if (checkpoint_id) {
      assertSafeStorageKey("checkpoint_id", checkpoint_id);
    }

    if (checkpoint_id) {
      const saved = this.storage[thread_id]?.[checkpoint_ns]?.[checkpoint_id];
      if (saved !== undefined) {
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const key = _generateKey(thread_id, checkpoint_ns, checkpoint_id);
        const deserializedCheckpoint: Checkpoint = await this.serde.loadsTyped(
          "json",
          checkpoint
        );

        if (deserializedCheckpoint.v < 4 && parentCheckpointId !== undefined) {
          await this._migratePendingSends(
            deserializedCheckpoint,
            thread_id,
            checkpoint_ns,
            parentCheckpointId
          );
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          Object.values(this.writes[key] || {}).map(
            async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            }
          )
        );
        const checkpointTuple: CheckpointTuple = {
          config,
          checkpoint: deserializedCheckpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        return checkpointTuple;
      }
    } else {
      const checkpoints = this.storage[thread_id]?.[checkpoint_ns];
      if (checkpoints !== undefined) {
        // eslint-disable-next-line prefer-destructuring
        checkpoint_id = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        const saved = checkpoints[checkpoint_id];
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const key = _generateKey(thread_id, checkpoint_ns, checkpoint_id);
        const deserializedCheckpoint: Checkpoint = await this.serde.loadsTyped(
          "json",
          checkpoint
        );

        if (deserializedCheckpoint.v < 4 && parentCheckpointId !== undefined) {
          await this._migratePendingSends(
            deserializedCheckpoint,
            thread_id,
            checkpoint_ns,
            parentCheckpointId
          );
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          Object.values(this.writes[key] || {}).map(
            async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            }
          )
        );
        const checkpointTuple: CheckpointTuple = {
          config: {
            configurable: {
              thread_id,
              checkpoint_id,
              checkpoint_ns,
            },
          },
          checkpoint: deserializedCheckpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        return checkpointTuple;
      }
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    // eslint-disable-next-line prefer-const
    let { before, limit, filter } = options ?? {};
    if (config.configurable?.thread_id !== undefined) {
      assertSafeStorageKey("thread_id", config.configurable.thread_id);
    }
    if (config.configurable?.checkpoint_ns !== undefined) {
      assertSafeStorageKey("checkpoint_ns", config.configurable.checkpoint_ns, {
        allowEmpty: true,
      });
    }
    if (config.configurable?.checkpoint_id) {
      assertSafeStorageKey("checkpoint_id", config.configurable.checkpoint_id);
    }
    if (before?.configurable?.checkpoint_id) {
      assertSafeStorageKey("checkpoint_id", before.configurable.checkpoint_id);
    }
    const threadIds = config.configurable?.thread_id
      ? [config.configurable?.thread_id]
      : Object.keys(this.storage);
    const configCheckpointNamespace = config.configurable?.checkpoint_ns;
    const configCheckpointId = config.configurable?.checkpoint_id;

    for (const threadId of threadIds) {
      for (const checkpointNamespace of Object.keys(
        this.storage[threadId] ?? {}
      )) {
        if (
          configCheckpointNamespace !== undefined &&
          checkpointNamespace !== configCheckpointNamespace
        ) {
          continue;
        }
        const checkpoints = this.storage[threadId]?.[checkpointNamespace] ?? {};
        const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) =>
          b[0].localeCompare(a[0])
        );

        for (const [
          checkpointId,
          [checkpoint, metadataStr, parentCheckpointId],
        ] of sortedCheckpoints) {
          // Filter by checkpoint ID from config
          if (configCheckpointId && checkpointId !== configCheckpointId) {
            continue;
          }

          // Filter by checkpoint ID from before config
          if (
            before &&
            before.configurable?.checkpoint_id &&
            checkpointId >= before.configurable.checkpoint_id
          ) {
            continue;
          }

          // Parse metadata
          const metadata = (await this.serde.loadsTyped(
            "json",
            metadataStr
          )) as CheckpointMetadata;

          if (
            filter &&
            !Object.entries(filter).every(
              ([key, value]) =>
                (metadata as unknown as Record<string, unknown>)[key] === value
            )
          ) {
            continue;
          }

          // Limit search results
          if (limit !== undefined) {
            if (limit <= 0) break;
            limit -= 1;
          }

          const key = _generateKey(threadId, checkpointNamespace, checkpointId);
          const writes = Object.values(this.writes[key] || {});

          const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
            writes.map(async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            })
          );

          const deserializedCheckpoint = await this.serde.loadsTyped(
            "json",
            checkpoint
          );

          if (
            deserializedCheckpoint.v < 4 &&
            parentCheckpointId !== undefined
          ) {
            await this._migratePendingSends(
              deserializedCheckpoint,
              threadId,
              checkpointNamespace,
              parentCheckpointId
            );
          }

          const checkpointTuple: CheckpointTuple = {
            config: {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: checkpointId,
              },
            },
            checkpoint: deserializedCheckpoint,
            metadata,
            pendingWrites,
          };
          if (parentCheckpointId !== undefined) {
            checkpointTuple.parentConfig = {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: parentCheckpointId,
              },
            };
          }
          yield checkpointTuple;
        }
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    if (threadId === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. ` +
          `When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. ` +
          `Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })`
      );
    }

    assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNamespace, {
      allowEmpty: true,
    });
    assertSafeStorageKey("checkpoint_id", checkpoint.id);

    if (!this.storage[threadId]) {
      this.storage[threadId] = Object.create(null);
    }
    if (!this.storage[threadId][checkpointNamespace]) {
      this.storage[threadId][checkpointNamespace] = Object.create(null);
    }

    const [[, serializedCheckpoint], [, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    this.storage[threadId][checkpointNamespace][checkpoint.id] = [
      serializedCheckpoint,
      serializedMetadata,
      config.configurable?.checkpoint_id, // parent
    ];

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. ` +
          `When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. ` +
          `Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })`
      );
    }
    if (checkpointId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.`
      );
    }
    assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNamespace, {
      allowEmpty: true,
    });
    assertSafeStorageKey("checkpoint_id", checkpointId);
    assertSafeStorageKey("task_id", taskId);
    const outerKey = _generateKey(threadId, checkpointNamespace, checkpointId);
    const outerWrites_ = this.writes[outerKey];
    if (this.writes[outerKey] === undefined) {
      this.writes[outerKey] = Object.create(null);
    }

    await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [, serializedValue] = await this.serde.dumpsTyped(value);
        const innerKey: [string, number] = [
          taskId,
          WRITES_IDX_MAP[channel] || idx,
        ];
        const innerKeyStr = `${innerKey[0]},${innerKey[1]}`;
        if (innerKey[1] >= 0 && outerWrites_ && innerKeyStr in outerWrites_) {
          return;
        }
        this.writes[outerKey][innerKeyStr] = [taskId, channel, serializedValue];
      })
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    assertSafeStorageKey("thread_id", threadId);
    delete this.storage[threadId];
    for (const key of Object.keys(this.writes)) {
      if (_parseKey(key).threadId === threadId) delete this.writes[key];
    }
  }

  /**
   * Override: walk the parent chain ONCE for all requested channels using
   * direct storage access.
   *
   * Each channel terminates independently at the nearest ancestor whose
   * stored `channel_values[ch]` is populated. Other channels keep walking
   * until they find their own terminator or hit the root.
   *
   * The seed value (whether a `DeltaSnapshot` or a plain pre-delta migration
   * blob) is the value AT that ancestor, prior to its own pending writes that
   * produce the child. Those on-path writes — including the ones stored on the
   * terminating ancestor — are always collected and replayed on top of the
   * seed, so a thread migrated from a pre-delta channel does not drop the
   * writes saved under the migration boundary checkpoint.
   *
   * @remarks Beta. See {@link BaseCheckpointSaver.getDeltaChannelHistory}.
   */
  async getDeltaChannelHistory(options: {
    config: RunnableConfig;
    channels: string[];
  }): Promise<Record<string, DeltaChannelHistory>> {
    const { config, channels } = options;
    if (channels.length === 0) return {};

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);

    if (threadId !== undefined) assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNs, { allowEmpty: true });

    const nsStorage = this.storage[threadId]?.[checkpointNs] ?? {};

    // Build the parent chain starting at the target's parent (the target's
    // own pending writes are for the next super-step and excluded).
    const chain: string[] = [];
    const targetEntry = checkpointId ? nsStorage[checkpointId] : undefined;
    let current: string | undefined = targetEntry?.[2];
    while (current !== undefined) {
      const entry = nsStorage[current];
      if (entry === undefined) break;
      chain.push(current);
      current = entry[2];
    }

    const collectedByCh: Record<string, CheckpointPendingWrite[]> = {};
    const seedByCh: Record<string, unknown> = {};
    const remaining = new Set(channels);
    for (const ch of channels) collectedByCh[ch] = [];

    for (const cpId of chain) {
      if (remaining.size === 0) break;
      const entry = nsStorage[cpId];
      const ckpt: Checkpoint | undefined =
        entry !== undefined
          ? await this.serde.loadsTyped("json", entry[0])
          : undefined;

      const blobValueByCh: Record<string, unknown> = {};
      const terminatedHere = new Set<string>();
      if (ckpt !== undefined) {
        for (const ch of remaining) {
          if (
            Object.prototype.hasOwnProperty.call(ckpt.channel_values, ch) &&
            ckpt.channel_values[ch] !== undefined
          ) {
            blobValueByCh[ch] = ckpt.channel_values[ch];
            terminatedHere.add(ch);
          }
        }
      }

      const stepWritesKey = _generateKey(threadId, checkpointNs, cpId);
      const stepWrites = Object.entries(this.writes[stepWritesKey] ?? {});
      // Sort by [taskId, idx] descending to mirror the Python walk order;
      // the full list is reversed once at the end to get oldest→newest.
      stepWrites.sort(([a], [b]) => {
        const [aTask, aIdx] = a.split(",");
        const [bTask, bIdx] = b.split(",");
        if (aTask !== bTask) return aTask < bTask ? 1 : -1;
        return Number(bIdx) - Number(aIdx);
      });
      for (const [, [tid, ch, serialized]] of stepWrites) {
        if (!remaining.has(ch)) continue;
        // Collect on-path writes regardless of seed type. A plain (pre-delta
        // migration) blob is the settled value AT that ancestor; its own
        // pending writes produce the child and must still be replayed, just
        // like a `DeltaSnapshot` seed. Skipping them would drop post-migration
        // writes saved under the migration boundary checkpoint.
        collectedByCh[ch].push([
          tid,
          ch,
          await this.serde.loadsTyped("json", serialized),
        ]);
      }

      for (const ch of terminatedHere) {
        seedByCh[ch] = blobValueByCh[ch];
        remaining.delete(ch);
      }
    }

    const result: Record<string, DeltaChannelHistory> = {};
    for (const ch of channels) {
      const entryH: DeltaChannelHistory = {
        writes: collectedByCh[ch].slice().reverse(),
      };
      if (Object.prototype.hasOwnProperty.call(seedByCh, ch)) {
        entryH.seed = seedByCh[ch];
      }
      result[ch] = entryH;
    }
    return result;
  }
}
