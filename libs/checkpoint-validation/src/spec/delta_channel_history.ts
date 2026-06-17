import {
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  DeltaSnapshot,
  emptyCheckpoint,
  isDeltaSnapshot,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { CheckpointerTestInitializer } from "../types.js";

const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

/**
 * Conformance tests for {@link BaseCheckpointSaver.getDeltaChannelHistory} — the
 * walk that reconstructs `DeltaChannel` state from `checkpoint_writes`.
 *
 * This is the one checkpointer method with no coverage in the default spec
 * suite, and it is intentionally **opt-in**: it is not run by {@link specTest},
 * so adding it does not raise the conformance bar for third-party savers (the
 * method is Beta and inherits a default implementation from
 * `BaseCheckpointSaver`). Each in-repo saver's `.spec.ts` calls it explicitly so
 * the shared base walk is validated against every backend's real storage —
 * Postgres, SQLite, Redis, MongoDB, and the `MemorySaver` override.
 *
 * The scenarios target the per-backend behaviours the walk depends on:
 * round-tripping `DeltaSnapshot` and plain-array seed blobs, following
 * `parentConfig` up the ancestor chain, and — critically — replaying concurrent
 * same-superstep writes in the canonical (task_id, idx) order regardless of how
 * a given store happens to return `pendingWrites` (insertion order, locale
 * collation, etc.).
 */
export function deltaChannelHistoryTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>
) {
  describe(`${initializer.checkpointerName}#getDeltaChannelHistory`, () => {
    let checkpointer: T;

    beforeEach(async () => {
      checkpointer = await initializer.createCheckpointer();
    });

    afterEach(async () => {
      await initializer.destroyCheckpointer?.(checkpointer);
    });

    describe.each(["root", "child"])("namespace: %s", (namespace) => {
      const checkpoint_ns = namespace === "root" ? "" : namespace;

      // Append a checkpoint as a child of `parentConfig`. Channel `values` are
      // stored as blobs, with `newVersions` derived to match so savers that only
      // persist changed channels (Postgres, Redis) still store them.
      async function putCheckpoint(
        parentConfig: RunnableConfig,
        id: string,
        values: Record<string, unknown>
      ): Promise<RunnableConfig> {
        const channel_versions = Object.fromEntries(
          Object.keys(values).map((k) => [k, 1])
        );
        const checkpoint: Checkpoint = {
          ...emptyCheckpoint(),
          id,
          channel_values: values,
          channel_versions,
        };
        return checkpointer.put(
          parentConfig,
          checkpoint,
          meta,
          channel_versions
        );
      }

      const rootConfig = (thread_id: string): RunnableConfig => ({
        configurable: { thread_id, checkpoint_ns },
      });

      it("walks ancestors collecting writes oldest→newest with a snapshot seed", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c2,
          channels: ["messages"],
        });

        expect(isDeltaSnapshot(hist.messages.seed)).toBe(true);
        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
        // The target's own writes are excluded; c0 + c1 deltas, oldest→newest.
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2]]);
      });

      it("retains a plain (migration) seed and replays boundary writes", async () => {
        const root = rootConfig(uuid6(3));

        // A thread migrated from a pre-delta channel stores a plain array at the
        // migration-boundary checkpoint; its writes are deltas to replay on top.
        const c0 = await putCheckpoint(root, uuid6(3), { messages: [0, 1] });
        await checkpointer.putWrites(c0, [["messages", [2]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        expect(isDeltaSnapshot(hist.messages.seed)).toBe(false);
        expect(hist.messages.seed).toEqual([0, 1]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[2]]);
      });

      it("orders concurrent same-superstep writes by task id", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // Persist the two tasks' writes in reverse task-id order. The walk must
        // re-sort them to (task_id, idx) so the reconstructed value matches live
        // execution regardless of the store's pending-writes return order.
        await checkpointer.putWrites(c0, [["messages", ["b"]]], "task-b");
        await checkpointer.putWrites(c0, [["messages", ["a"]]], "task-a");
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        expect(hist.messages.writes.map((w) => w[0])).toEqual([
          "task-a",
          "task-b",
        ]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([["a"], ["b"]]);
      });

      it("omits the seed when no ancestor stored a value", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {});
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        // Reaching the root without a stored value => "start empty".
        expect(hist.messages.seed).toBeUndefined();
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1]]);
      });
    });
  });
}
