import {
  type BaseCheckpointSaver,
  type CheckpointTuple,
  type PendingWrite,
  type Checkpoint,
  TASKS,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CheckpointerTestInitializer } from "../types.js";
import {
  it_skipForSomeModules,
  parentAndChildCheckpointTuplesWithWrites,
  putTuples,
} from "../test_utils.js";

export function getTupleTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>
) {
  describe(`${initializer.checkpointerName}#getTuple`, () => {
    let checkpointer: T;
    beforeAll(async () => {
      checkpointer = await initializer.createCheckpointer();
    });

    afterAll(async () => {
      await initializer.destroyCheckpointer?.(checkpointer);
    });

    describe.each(["root", "child"])("namespace: %s", (namespace) => {
      let thread_id: string;
      const checkpoint_ns = namespace === "root" ? "" : namespace;

      let parentCheckpointId: string;
      let childCheckpointId: string;

      let generatedParentTuple: CheckpointTuple;
      let generatedChildTuple: CheckpointTuple;

      let parentTuple: CheckpointTuple | undefined;
      let childTuple: CheckpointTuple | undefined;
      let latestTuple: CheckpointTuple | undefined;

      beforeAll(async () => {
        thread_id = uuid6(-3);
        parentCheckpointId = uuid6(-3);
        childCheckpointId = uuid6(-3);

        const writesToParent = [
          {
            taskId: "pending_sends_task",
            writes: [[TASKS, ["add_fish"]]] as PendingWrite[],
          },
        ];

        const writesToChild = [
          {
            taskId: "add_fish",
            writes: [["animals", ["dog", "fish"]]] as PendingWrite[],
          },
        ];

        ({ parent: generatedParentTuple, child: generatedChildTuple } =
          parentAndChildCheckpointTuplesWithWrites({
            thread_id,
            parentCheckpointId,
            childCheckpointId,
            checkpoint_ns,
            initialChannelValues: {
              animals: ["dog"],
            },
            writesToParent,
            writesToChild,
          }));

        const storedTuples = putTuples(checkpointer, [
          {
            tuple: generatedParentTuple,
            writes: writesToParent,
            newVersions: { animals: 1 },
          },
          {
            tuple: generatedChildTuple,
            writes: writesToChild,
            newVersions: { animals: 2 },
          },
        ]);

        parentTuple = (await storedTuples.next()).value;
        childTuple = (await storedTuples.next()).value;

        latestTuple = await checkpointer.getTuple({
          configurable: { thread_id, checkpoint_ns },
        });
      });

      describe("success cases", () => {
        describe("when checkpoint_id is provided", () => {
          describe("first checkpoint", () => {
            it("should return a tuple containing the checkpoint without modification", () => {
              expect(parentTuple).not.toBeUndefined();
              expect(parentTuple?.checkpoint).toEqual(
                generatedParentTuple.checkpoint
              );
            });

            it("should return a tuple containing the checkpoint's metadata without modification", () => {
              expect(parentTuple?.metadata).not.toBeUndefined();
              expect(parentTuple?.metadata).toEqual(
                generatedParentTuple.metadata
              );
            });

            it("should return a tuple containing a config object that has the correct thread_id, checkpoint_ns, and checkpoint_id", () => {
              expect(parentTuple?.config).not.toBeUndefined();

              expect(parentTuple?.config).toEqual({
                configurable: {
                  thread_id,
                  checkpoint_ns,
                  checkpoint_id: parentCheckpointId,
                },
              });
            });

            it("should return a tuple containing an undefined parentConfig", () => {
              expect(parentTuple?.parentConfig).toBeUndefined();
            });

            it("should return a tuple containing the writes against the checkpoint", () => {
              expect(parentTuple?.pendingWrites).toEqual([
                ["pending_sends_task", TASKS, ["add_fish"]],
              ]);
            });
          });

          describe("subsequent checkpoints", () => {
            it(`should return a tuple containing the checkpoint`, async () => {
              expect(childTuple).not.toBeUndefined();
              expect(childTuple?.checkpoint).toEqual(
                generatedChildTuple.checkpoint
              );
            });

            it("should return a tuple containing the checkpoint's metadata without modification", () => {
              expect(childTuple?.metadata).not.toBeUndefined();
              expect(childTuple?.metadata).toEqual(
                generatedChildTuple.metadata
              );
            });

            it("should return a tuple containing a config object that has the correct thread_id, checkpoint_ns, and checkpoint_id", () => {
              expect(childTuple?.config).not.toBeUndefined();
              expect(childTuple?.config).toEqual({
                configurable: {
                  thread_id,
                  checkpoint_ns,
                  checkpoint_id: childCheckpointId,
                },
              });
            });

            it("should return a tuple containing a parentConfig with the correct thread_id, checkpoint_ns, and checkpoint_id", () => {
              expect(childTuple?.parentConfig).toEqual({
                configurable: {
                  thread_id,
                  checkpoint_ns,
                  checkpoint_id: parentCheckpointId,
                },
              });
            });

            it("should return a tuple containing the writes against the checkpoint", () => {
              expect(childTuple?.pendingWrites).toEqual([
                ["add_fish", "animals", ["dog", "fish"]],
              ]);
            });
          });
        });

        describe("when checkpoint_id is not provided", () => {
          it(`should return a tuple containing the latest checkpoint`, async () => {
            expect(latestTuple).not.toBeUndefined();
            expect(latestTuple?.checkpoint).toEqual(
              generatedChildTuple.checkpoint
            );
          });

          it("should return a tuple containing the latest checkpoint's metadata without modification", () => {
            expect(latestTuple?.metadata).not.toBeUndefined();
            expect(latestTuple?.metadata).toEqual(generatedChildTuple.metadata);
          });

          it("should return a tuple containing a config object that has the correct thread_id, checkpoint_ns, and checkpoint_id for the latest checkpoint", () => {
            expect(latestTuple?.config).not.toBeUndefined();
            expect(latestTuple?.config).toEqual({
              configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: childCheckpointId,
              },
            });
          });

          it("should return a tuple containing a parentConfig with the correct thread_id, checkpoint_ns, and checkpoint_id for the latest checkpoint's parent", () => {
            expect(latestTuple?.parentConfig).toEqual({
              configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: parentCheckpointId,
              },
            });
          });

          it("should return a tuple containing the writes against the latest checkpoint", () => {
            expect(latestTuple?.pendingWrites).toEqual([
              ["add_fish", "animals", ["dog", "fish"]],
            ]);
          });
        });
      });

      describe("failure cases", () => {
        it("should return undefined if the checkpoint_id is not found", async () => {
          const configWithInvalidCheckpointId = {
            configurable: {
              thread_id: uuid6(-3),
              checkpoint_ns,
              checkpoint_id: uuid6(-3),
            },
          };
          const checkpointTuple = await checkpointer.getTuple(
            configWithInvalidCheckpointId
          );
          expect(checkpointTuple).toBeUndefined();
        });

        it("should return undefined if the thread_id is undefined", async () => {
          const missingThreadIdConfig = {
            configurable: {
              checkpoint_ns,
            },
          };

          expect(
            await checkpointer.getTuple(missingThreadIdConfig)
          ).toBeUndefined();
        });
      });

      it_skipForSomeModules(initializer.checkpointerName, {
        "@langchain/langgraph-checkpoint-mongodb":
          "MongoDBSaver never stored pending sends",
      })("should migrate pending sends", async () => {
        let config: RunnableConfig = {
          configurable: { thread_id: "thread-1", checkpoint_ns: "" },
        };

        const checkpoint0: Checkpoint = {
          v: 1,
          id: uuid6(0),
          ts: "2024-04-19T17:19:07.952Z",
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        };

        config = await checkpointer.put(
          config,
          checkpoint0,
          { source: "loop", parents: {}, step: 0 },
          {}
        );

        await checkpointer.putWrites(
          config,
          [
            [TASKS, "send-1"],
            [TASKS, "send-2"],
          ],
          "task-1"
        );
        await checkpointer.putWrites(config, [[TASKS, "send-3"]], "task-2");

        // check that fetching checkpount 0 doesn't attach pending sends
        // (they should be attached to the next checkpoint)
        const tuple0 = await checkpointer.getTuple(config);
        expect(tuple0?.checkpoint.channel_values).toEqual({});
        expect(tuple0?.checkpoint.channel_versions).toEqual({});

        // create second checkpoint
        const checkpoint1: Checkpoint = {
          v: 1,
          id: uuid6(1),
          ts: "2024-04-20T17:19:07.952Z",
          channel_values: {},
          channel_versions: checkpoint0.channel_versions,
          versions_seen: checkpoint0.versions_seen,
        };
        config = await checkpointer.put(
          config,
          checkpoint1,
          { source: "loop", parents: {}, step: 1 },
          {}
        );

        // check that pending sends are attached to checkpoint1
        const checkpoint1Tuple = await checkpointer.getTuple(config);
        expect(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
          [TASKS]: ["send-1", "send-2", "send-3"],
        });
        expect(
          checkpoint1Tuple?.checkpoint.channel_versions[TASKS]
        ).toBeDefined();
      });
    });
  });
}
