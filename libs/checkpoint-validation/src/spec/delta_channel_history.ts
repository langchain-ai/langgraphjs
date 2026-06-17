import {
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  deltaExitStepTaskId,
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
 * `parentConfig` up the ancestor chain, grouping each ancestor checkpoint's
 * writes into its own super-step, and — critically — ordering concurrent
 * same-superstep writes by the canonical (task_id, idx) within each group
 * regardless of how a given store happens to return `pendingWrites` (insertion
 * order, locale collation, etc.).
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
        // The target's own writes are excluded; c0 + c1 deltas are distinct
        // super-steps, grouped oldest→newest.
        expect(hist.messages.writes).toEqual([
          [["task0", "messages", [1]]],
          [["task1", "messages", [2]]],
        ]);
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
        expect(hist.messages.writes).toEqual([[["task0", "messages", [2]]]]);
      });

      it("groups concurrent same-superstep writes and orders them by task id", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // Persist the two tasks' writes in reverse task-id order. The walk must
        // keep them in a single super-step group, re-sorted to (task_id, idx),
        // so the consumer reconstructs the same value (and can apply per-step
        // Overwrite semantics) regardless of the store's pending-writes order.
        await checkpointer.putWrites(c0, [["messages", ["b"]]], "task-b");
        await checkpointer.putWrites(c0, [["messages", ["a"]]], "task-a");
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        // One super-step group holding both concurrent writes, task-id ordered.
        expect(hist.messages.writes).toEqual([
          [
            ["task-a", "messages", ["a"]],
            ["task-b", "messages", ["b"]],
          ],
        ]);
      });

      it("keeps a concurrent plain write and Overwrite in the same super-step group", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // A plain write and an Overwrite produced concurrently in one step must
        // land in a single group so the consumer can apply option-A semantics
        // (the Overwrite wins the whole step). The walk only groups/orders; it
        // does not interpret the Overwrite sentinel itself.
        await checkpointer.putWrites(c0, [["messages", ["plain"]]], "task-a");
        await checkpointer.putWrites(
          c0,
          [["messages", { __overwrite__: ["over"] }]],
          "task-b"
        );
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        expect(hist.messages.writes).toEqual([
          [
            ["task-a", "messages", ["plain"]],
            ["task-b", "messages", { __overwrite__: ["over"] }],
          ],
        ]);
      });

      it("splits exit-mode supersteps stored under one anchor checkpoint", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // "exit" durability persists writes from several supersteps under one
        // anchor checkpoint, tagged with step-prefixed synthetic task ids. The
        // walk must re-split them into separate super-step groups so that an
        // Overwrite in an earlier step does not swallow a later step's append.
        const tidA = deltaExitStepTaskId(0, "taskA");
        const tidB = deltaExitStepTaskId(1, "taskB");
        await checkpointer.putWrites(
          c0,
          [["messages", { __overwrite__: ["a"] }]],
          tidA
        );
        await checkpointer.putWrites(c0, [["messages", ["b"]]], tidB);
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await checkpointer.getDeltaChannelHistory({
          config: c1,
          channels: ["messages"],
        });

        // Two distinct super-step groups, chronological, NOT one merged group.
        expect(hist.messages.writes).toEqual([
          [[tidA, "messages", { __overwrite__: ["a"] }]],
          [[tidB, "messages", ["b"]]],
        ]);
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
        expect(hist.messages.writes).toEqual([[["task0", "messages", [1]]]]);
      });
    });
  });
}
