import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointMetadata,
  MemorySaver,
} from "@langchain/langgraph";
import { FileSystemPersistence } from "./persist.mjs";

const EXCLUDED_KEYS = ["checkpoint_ns", "checkpoint_id", "run_id", "thread_id"];

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type WriteKey = [
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string,
];

const WriteKey = {
  serialize: (key: WriteKey): string => {
    return JSON.stringify(key);
  },
  deserialize: (key: string): WriteKey => {
    const [threadId, checkpointNamespace, checkpointId] = JSON.parse(key);
    return [threadId, checkpointNamespace, checkpointId];
  },
};

const conn = new FileSystemPersistence<{
  storage: typeof MemorySaver.prototype.storage;
  writes: typeof MemorySaver.prototype.writes;
}>(".langgraphjs_api.checkpointer.json", () => ({
  storage: {},
  writes: {},
}));

class InMemorySaver extends MemorySaver {
  async initialize(cwd: string) {
    await conn.initialize(cwd);
    await conn.with(({ storage, writes }) => {
      this.storage = storage;
      this.writes = writes;
    });

    return conn;
  }

  clear() {
    // { [threadId: string]: { [checkpointNs: string]: { [checkpointId]: [checkpoint, metadata, parentId] } }}
    this.storage = {};

    // { [WriteKey]: CheckpointPendingWrite[] }
    this.writes = {};
  }

  // Patch every method that has access to this.storage or this.writes
  // to also persist the changes to the filesystem in a non-blocking manner
  async getTuple(
    ...args: Parameters<MemorySaver["getTuple"]>
  ): ReturnType<MemorySaver["getTuple"]> {
    return await conn.with(() => super.getTuple(...args));
  }

  async *list(
    ...args: Parameters<MemorySaver["list"]>
  ): ReturnType<MemorySaver["list"]> {
    yield* conn.withGenerator(super.list(...args));
  }

  async putWrites(
    ...args: Parameters<MemorySaver["putWrites"]>
  ): Promise<void> {
    return await conn.with(() => super.putWrites(...args));
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    return await conn.with(() =>
      super.put(config, checkpoint, {
        ...Object.fromEntries(
          Object.entries(config.configurable ?? {}).filter(
            ([key]) => !key.startsWith("__") && !EXCLUDED_KEYS.includes(key),
          ),
        ),
        ...config.metadata,
        ...metadata,
      }),
    );
  }

  async delete(threadId: string, runId: string | null | undefined) {
    if (this.storage[threadId] == null) return;
    return await conn.with(() => {
      if (runId != null) {
        const writeKeysToDelete: string[] = [];

        for (const ns of Object.keys(this.storage[threadId])) {
          for (const id of Object.keys(this.storage[threadId][ns])) {
            const [_checkpoint, metadata, _parentId] =
              this.storage[threadId][ns][id];

            const jsonMetadata = JSON.parse(textDecoder.decode(metadata));
            if (jsonMetadata.run_id === runId) {
              delete this.storage[threadId][ns][id];
              writeKeysToDelete.push(WriteKey.serialize([threadId, ns, id]));

              if (Object.keys(this.storage[threadId][ns]).length === 0) {
                delete this.storage[threadId][ns];
              }
            }
          }
        }

        for (const key of writeKeysToDelete) {
          delete this.writes[key];
        }
      } else {
        delete this.storage[threadId];

        // delete all writes for this thread
        const writeKeys = Object.keys(this.writes);
        for (const key of writeKeys) {
          const [writeThreadId] = WriteKey.deserialize(key);
          if (writeThreadId === threadId) delete this.writes[key];
        }
      }
    });
  }

  async copy(threadId: string, newThreadId: string) {
    return await conn.with(() => {
      // copy storage over
      const newThreadCheckpoints: (typeof this.storage)[string] = {};
      for (const oldNs of Object.keys(this.storage[threadId] ?? {})) {
        const newNs = oldNs.replace(threadId, newThreadId);

        for (const oldId of Object.keys(this.storage[threadId][oldNs])) {
          const newId = oldId.replace(threadId, newThreadId);

          const [checkpoint, metadata, oldParentId] =
            this.storage[threadId][oldNs][oldId];

          const newParentId = oldParentId?.replace(threadId, newThreadId);
          const rawMetadata = textDecoder
            .decode(metadata)
            .replaceAll(threadId, newThreadId);

          newThreadCheckpoints[newNs] ??= {};
          newThreadCheckpoints[newNs][newId] = [
            checkpoint,
            textEncoder.encode(rawMetadata),
            newParentId,
          ];
        }
      }

      this.storage[newThreadId] = newThreadCheckpoints;

      // copy writes over (if any)
      const outerKeys: string[] = [];
      for (const keyJson of Object.keys(this.writes)) {
        const key = WriteKey.deserialize(keyJson);
        if (key[0] === threadId) outerKeys.push(keyJson);
      }

      for (const keyJson of outerKeys) {
        const [_threadId, checkpointNamespace, checkpointId] =
          WriteKey.deserialize(keyJson);

        this.writes[
          WriteKey.serialize([newThreadId, checkpointNamespace, checkpointId])
        ] = structuredClone(this.writes[keyJson]);
      }
    });
  }

  toJSON() {
    // Prevent serialization of internal state
    return "[InMemorySaver]";
  }
}

export const checkpointer = new InMemorySaver();
