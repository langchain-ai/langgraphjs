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
  storage: Record<
    string,
    Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>
  > = {};

  writes: Record<string, Record<string, [string, string, Uint8Array]>> = {};

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
      this.storage[threadId] = {};
    }
    if (!this.storage[threadId][checkpointNamespace]) {
      this.storage[threadId][checkpointNamespace] = {};
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
      this.writes[outerKey] = {};
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
}
