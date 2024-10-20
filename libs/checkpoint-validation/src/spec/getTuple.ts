import {
  CheckpointTuple,
  PendingWrite,
  TASKS,
  uuid6,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import { mergeConfigs, RunnableConfig } from "@langchain/core/runnables";
import { CheckpointSaverTestInitializer } from "../types.js";
import { parentAndChildCheckpointTuplesWithWrites } from "./data.js";
import { putTuples } from "./util.js";

export function getTupleTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointSaverTestInitializer<T>
) {
  describe(`${initializer.saverName}#getTuple`, () => {
    let saver: T;
    let initializerConfig: RunnableConfig;
    beforeAll(async () => {
      const baseConfig = {
        configurable: {},
      };
      initializerConfig = mergeConfigs(
        baseConfig,
        await initializer.configure?.(baseConfig)
      );
      saver = await initializer.createSaver(initializerConfig);
    });

    afterAll(async () => {
      await initializer.destroySaver?.(saver, initializerConfig);
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

        const config = mergeConfigs(initializerConfig, {
          configurable: { thread_id, checkpoint_ns },
        });

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
            config,
            parentCheckpointId,
            childCheckpointId,
            checkpoint_ns,
            initialChannelValues: {
              animals: ["dog"],
            },
            writesToParent,
            writesToChild,
          }));

        const storedTuples = putTuples(
          saver,
          [
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
          ],
          config
        );

        parentTuple = (await storedTuples.next()).value;
        childTuple = (await storedTuples.next()).value;

        latestTuple = await saver.getTuple(
          mergeConfigs(config, {
            configurable: { checkpoint_ns, checkpoint_id: undefined },
          })
        );
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
          const configWithInvalidCheckpointId = mergeConfigs(
            initializerConfig,
            {
              configurable: {
                thread_id: uuid6(-3),
                checkpoint_ns,
                checkpoint_id: uuid6(-3),
              },
            }
          );
          const checkpointTuple = await saver.getTuple(
            configWithInvalidCheckpointId
          );
          expect(checkpointTuple).toBeUndefined();
        });

        it("should return undefined if the thread_id is undefined", async () => {
          const missingThreadIdConfig: RunnableConfig = {
            ...initializerConfig,
            configurable: Object.fromEntries(
              Object.entries(initializerConfig.configurable ?? {}).filter(
                ([key]) => key !== "thread_id"
              )
            ),
          };

          expect(await saver.getTuple(missingThreadIdConfig)).toBeUndefined();
        });
      });
    });
  });
}
