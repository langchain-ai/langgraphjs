import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type DeltaChannelHistory,
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
 *
 * Every scenario also compares the saver's result with the base class's walk
 * over `getTuple` on the same storage, so a saver that overrides the method
 * must return exactly what the walk returns.
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
        values: Record<string, unknown>,
        channel_versions: Record<string, number> = Object.fromEntries(
          Object.keys(values).map((k) => [k, 1])
        ),
        newVersions: Record<string, number> = channel_versions
      ): Promise<RunnableConfig> {
        const checkpoint: Checkpoint = {
          ...emptyCheckpoint(),
          id,
          channel_values: values,
          channel_versions,
        };
        return checkpointer.put(parentConfig, checkpoint, meta, newVersions);
      }

      const rootConfig = (thread_id: string): RunnableConfig => ({
        configurable: { thread_id, checkpoint_ns },
      });

      async function history(
        config: RunnableConfig,
        channels: string[]
      ): Promise<Record<string, DeltaChannelHistory>> {
        const args = { config, channels };
        const result = await checkpointer.getDeltaChannelHistory(args);
        expect(result).toStrictEqual(
          await BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(
            checkpointer,
            args
          )
        );
        return result;
      }

      it("walks ancestors collecting writes oldest→newest with a snapshot seed", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, uuid6(3), {});

        const hist = await history(c2, ["messages"]);

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

        const hist = await history(c1, ["messages"]);

        expect(isDeltaSnapshot(hist.messages.seed)).toBe(false);
        expect(hist.messages.seed).toEqual([0, 1]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[2]]);
      });

      it("orders concurrent same-superstep writes by task path", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // Task ids are chosen to sort OPPOSITE to their task paths, so the
        // test cannot pass by chance under a task-id ordering. Persist the
        // writes in yet another (reverse path) order, so an
        // insertion-order implementation cannot pass either.
        await checkpointer.putWrites(
          c0,
          [["messages", ["b"]]],
          "00000000-0000-0000-0000-000000000000",
          "~pull, 02"
        );
        await checkpointer.putWrites(
          c0,
          [["messages", ["a"]]],
          "ffffffff-ffff-ffff-ffff-ffffffffffff",
          "~pull, 01"
        );
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await history(c1, ["messages"]);

        // writesSortKey order — the order live execution applies a
        // superstep's writes in. Task-id order would give ["b", "a"].
        expect(hist.messages.writes.map((w) => w[2])).toEqual([["a"], ["b"]]);
      });

      it("orders pathless writes first, by task id (legacy rows)", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // Writes stored without a task path (graph input, pre-column rows,
        // savers that don't persist one) sort first — before every real task
        // path — then by task id. The task ids here sort opposite to that
        // expectation, so a path-order-only implementation cannot pass.
        await checkpointer.putWrites(
          c0,
          [["messages", ["from_node"]]],
          "00000000-0000-0000-0000-000000000000",
          "~pull, a"
        );
        await checkpointer.putWrites(
          c0,
          [["messages", ["from_input"]]],
          "ffffffff-ffff-ffff-ffff-ffffffffffff"
        );
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await history(c1, ["messages"]);

        expect(hist.messages.writes.map((w) => w[2])).toEqual([
          ["from_input"],
          ["from_node"],
        ]);
      });

      it("replays one task's writes to a channel in index order", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([]),
        });
        // Twelve writes in one call, so an order that compares indexes as
        // strings puts 10 and 11 before 2.
        const steps = Array.from({ length: 12 }, (_, i) => i);
        await checkpointer.putWrites(
          c0,
          steps.map((i) => ["messages", [i]]),
          "task0"
        );
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await history(c1, ["messages"]);

        expect(hist.messages.writes.map((w) => w[2])).toEqual(
          steps.map((i) => [i])
        );
      });

      it("omits the seed when no ancestor stored a value", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {});
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});

        const hist = await history(c1, ["messages"]);

        // Reaching the root without a stored value => "start empty".
        expect(hist.messages.seed).toBeUndefined();
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1]]);
      });

      it("reads from the latest checkpoint when the config has no checkpoint id", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        await putCheckpoint(c0, uuid6(3), {});

        const hist = await history(root, ["messages"]);

        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1]]);
        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
      });

      it("seeds from the nearest of several snapshots and skips the target's writes", async () => {
        const root = rootConfig(uuid6(3));

        let config = root;
        for (let step = 0; step < 5; step += 1) {
          const values =
            step === 0 || step === 2
              ? { messages: new DeltaSnapshot([step]) }
              : {};
          config = await putCheckpoint(config, uuid6(3), values, {
            messages: step + 1,
          });
          await checkpointer.putWrites(config, [["messages", [step]]], "task");
        }
        const c5 = await putCheckpoint(config, uuid6(3), {});
        await checkpointer.putWrites(c5, [["messages", ["pending"]]], "task");

        const hist = await history(c5, ["messages"]);

        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([2]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[2], [3], [4]]);
      });

      it("walks each channel to its own depth in one call", async () => {
        const root = rootConfig(uuid6(3));

        // `a` stores a snapshot at step 1 and `b` at step 3; `sparse` is
        // written every other step and never stored; `unwritten` never
        // appears in storage at all.
        let config = root;
        for (let step = 0; step < 5; step += 1) {
          const values: Record<string, unknown> = {};
          if (step === 1) values.a = new DeltaSnapshot(["a1"]);
          if (step === 3) values.b = new DeltaSnapshot(["b3"]);
          config = await putCheckpoint(config, uuid6(3), values);
          await checkpointer.putWrites(
            config,
            [
              ["a", step],
              ["b", step],
              ...(step % 2 === 0 ? [["sparse", step] as [string, number]] : []),
            ],
            `task${step}`
          );
        }

        const hist = await history(config, ["a", "b", "sparse", "unwritten"]);

        expect((hist.a.seed as DeltaSnapshot).value).toEqual(["a1"]);
        expect((hist.b.seed as DeltaSnapshot).value).toEqual(["b3"]);
        expect(hist.sparse).not.toHaveProperty("seed");
        expect(hist.unwritten).toStrictEqual({ writes: [] });
        expect({
          a: hist.a.writes.map((w) => w[2]),
          b: hist.b.writes.map((w) => w[2]),
          sparse: hist.sparse.writes.map((w) => w[2]),
        }).toEqual({ a: [1, 2, 3], b: [3], sparse: [0, 2] });
      });

      it("does not seed from a channel version that stored no value", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        // The version moves on with no stored value, as it does on every
        // DeltaChannel step that does not snapshot.
        const c1 = await putCheckpoint(c0, uuid6(3), {}, { messages: 2 });
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, uuid6(3), {}, { messages: 3 });

        const hist = await history(c2, ["messages"]);

        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2]]);
      });

      it("seeds from a value stored further back under an unchanged version", async () => {
        const root = rootConfig(uuid6(3));

        // `files` keeps version 1 from c0 on, as a channel that is not
        // written again does, so its nearest ancestor already holds a value.
        let config = await putCheckpoint(root, uuid6(3), {
          files: new DeltaSnapshot(["f0"]),
          messages: new DeltaSnapshot([0]),
        });
        for (let step = 1; step < 4; step += 1) {
          await checkpointer.putWrites(config, [["messages", [step]]], "task");
          config = await putCheckpoint(
            config,
            uuid6(3),
            {},
            { files: 1, messages: step + 1 },
            { messages: step + 1 }
          );
        }

        const hist = await history(config, ["files", "messages"]);

        expect((hist.files.seed as DeltaSnapshot).value).toEqual(["f0"]);
        expect(hist.files.writes).toEqual([]);
        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2], [3]]);
      });

      it("keeps a thread's namespaces apart when their versions collide", async () => {
        const thread_id = uuid6(3);
        const other = checkpoint_ns === "" ? "other" : "";

        // The same versions in both namespaces of one thread, the other
        // namespace written first, so a read that ignores the namespace
        // finds its rows first.
        const configs: Record<string, RunnableConfig> = {};
        for (const ns of [other, checkpoint_ns]) {
          configs[ns] = { configurable: { thread_id, checkpoint_ns: ns } };
        }
        for (let step = 0; step < 3; step += 1) {
          for (const ns of [other, checkpoint_ns]) {
            configs[ns] = await putCheckpoint(
              configs[ns],
              uuid6(3),
              step === 0 ? { messages: new DeltaSnapshot([`${ns}:0`]) } : {},
              { messages: step + 1 }
            );
            if (step < 2) {
              await checkpointer.putWrites(
                configs[ns],
                [["messages", [`${ns}:${step + 1}`]]],
                "task"
              );
            }
          }
        }

        const hist = await history(configs[checkpoint_ns], ["messages"]);

        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([
          `${checkpoint_ns}:0`,
        ]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([
          [`${checkpoint_ns}:1`],
          [`${checkpoint_ns}:2`],
        ]);
      });

      it("follows the target's own branch when it is not the latest checkpoint", async () => {
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, uuid6(3), {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        // Two branches from c1, as a fork from c1 makes; `b` is the newer one.
        const a = await putCheckpoint(c1, uuid6(3), {});
        await checkpointer.putWrites(a, [["messages", ["a"]]], "taskA");
        const aChild = await putCheckpoint(a, uuid6(3), {});
        const b = await putCheckpoint(c1, uuid6(3), {});
        await checkpointer.putWrites(b, [["messages", ["b"]]], "taskB");
        await putCheckpoint(b, uuid6(3), {});

        const writes = async (config: RunnableConfig) =>
          (await history(config, ["messages"])).messages.writes.map(
            (w) => w[2]
          );

        expect(await writes(aChild)).toEqual([[1], [2], ["a"]]);
        expect(await writes(b)).toEqual([[1], [2]]);
        expect(await writes(c0)).toEqual([]);
        expect(await writes(root)).toEqual([[1], [2], ["b"]]);
      });

      // Checkpoint ids are time-based, so a thread whose writers' clocks
      // disagree can store a parent whose id sorts above its child's.
      it("follows a parent whose id sorts above its child's", async () => {
        const [low, mid, high] = [uuid6(3), uuid6(3), uuid6(3)];
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, mid, {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, low, {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, high, {});

        const hist = await history(c2, ["messages"]);

        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2]]);
      });

      it("follows a parent whose id sorts above the target's", async () => {
        const [low, mid, high] = [uuid6(3), uuid6(3), uuid6(3)];
        const root = rootConfig(uuid6(3));

        const c0 = await putCheckpoint(root, low, {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const c1 = await putCheckpoint(c0, high, {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, mid, {});

        const hist = await history(c2, ["messages"]);

        expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
        expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2]]);
      });

      it("stops at a parent that was never stored", async () => {
        const thread_id = uuid6(3);
        const c0 = await putCheckpoint(rootConfig(thread_id), uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const missing: RunnableConfig = {
          configurable: { thread_id, checkpoint_ns, checkpoint_id: uuid6(3) },
        };
        const c1 = await putCheckpoint(missing, uuid6(3), {});
        await checkpointer.putWrites(c1, [["messages", [2]]], "task1");
        const c2 = await putCheckpoint(c1, uuid6(3), {});

        const hist = await history(c2, ["messages"]);

        expect(hist.messages).toStrictEqual({
          writes: [["task1", "messages", [2]]],
        });
      });

      it("returns empty histories when there is no target checkpoint", async () => {
        const empty = { writes: [] };
        const thread = rootConfig(uuid6(3));
        expect(await history(thread, ["messages", "files"])).toStrictEqual({
          messages: empty,
          files: empty,
        });

        const c0 = await putCheckpoint(thread, uuid6(3), {
          messages: new DeltaSnapshot([0]),
        });
        await checkpointer.putWrites(c0, [["messages", [1]]], "task0");
        const unknownId: RunnableConfig = {
          configurable: { ...c0.configurable, checkpoint_id: uuid6(3) },
        };
        expect(await history(unknownId, ["messages"])).toStrictEqual({
          messages: empty,
        });
        expect(await history(c0, [])).toStrictEqual({});
      });
    });
  });
}
