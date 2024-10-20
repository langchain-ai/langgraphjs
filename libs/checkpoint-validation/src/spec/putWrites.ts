import {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  uuid6,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import { mergeConfigs, RunnableConfig } from "@langchain/core/runnables";
import { CheckpointSaverTestInitializer } from "../types.js";
import { initialCheckpointTuple } from "./data.js";

export function putWritesTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointSaverTestInitializer<T>
) {
  describe(`${initializer.saverName}#putWrites`, () => {
    let saver: T;
    let initializerConfig: RunnableConfig;
    let thread_id: string;
    let checkpoint_id: string;

    beforeEach(async () => {
      thread_id = uuid6(-3);
      checkpoint_id = uuid6(-3);

      const baseConfig = {
        configurable: {
          thread_id,
        },
      };
      initializerConfig = mergeConfigs(
        baseConfig,
        await initializer.configure?.(baseConfig)
      );
      saver = await initializer.createSaver(initializerConfig);
    });

    afterEach(async () => {
      await initializer.destroySaver?.(saver, initializerConfig);
    });

    describe.each(["root", "child"])("namespace: %s", (namespace) => {
      const checkpoint_ns = namespace === "root" ? "" : namespace;
      let configArgument: RunnableConfig;
      let checkpoint: Checkpoint;
      let metadata: CheckpointMetadata | undefined;

      describe("success cases", () => {
        let returnedConfig!: RunnableConfig;
        let savedCheckpointTuple: CheckpointTuple | undefined;

        beforeEach(async () => {
          ({ checkpoint, metadata } = initialCheckpointTuple({
            config: initializerConfig,
            checkpoint_id,
            checkpoint_ns,
          }));

          configArgument = mergeConfigs(initializerConfig, {
            configurable: { checkpoint_ns },
          });

          // ensure the test checkpoint does not already exist
          const existingCheckpoint = await saver.get(
            mergeConfigs(configArgument, {
              configurable: {
                checkpoint_id,
              },
            })
          );
          expect(existingCheckpoint).toBeUndefined(); // our test checkpoint should not exist yet

          returnedConfig = await saver.put(
            configArgument,
            checkpoint,
            metadata!,
            {} /* not sure what to do about newVersions, as it's unused */
          );

          await saver.putWrites(
            mergeConfigs(configArgument, returnedConfig),
            [["animals", "dog"]],
            "pet_task"
          );

          savedCheckpointTuple = await saver.getTuple(
            mergeConfigs(configArgument, returnedConfig)
          );

          // fail here if `put` or `getTuple` is broken so we don't get a bunch of noise from the actual test cases below
          expect(savedCheckpointTuple).not.toBeUndefined();
          expect(savedCheckpointTuple?.checkpoint).toEqual(checkpoint);
          expect(savedCheckpointTuple?.metadata).toEqual(metadata);
          expect(savedCheckpointTuple?.config).toEqual(
            expect.objectContaining(
              // allow the saver to add additional fields to the config
              mergeConfigs(configArgument, { configurable: { checkpoint_id } })
            )
          );
        });

        it("should store writes to the checkpoint", async () => {
          expect(savedCheckpointTuple?.pendingWrites).toEqual([
            ["pet_task", "animals", "dog"],
          ]);
        });
      });

      describe("failure cases", () => {
        it("should fail if the thread_id is missing", async () => {
          const missingThreadIdConfig: RunnableConfig = {
            ...configArgument,
            configurable: Object.fromEntries(
              Object.entries(configArgument.configurable ?? {}).filter(
                ([key]) => key !== "thread_id"
              )
            ),
          };

          await expect(
            async () =>
              await saver.putWrites(
                missingThreadIdConfig,
                [["animals", "dog"]],
                "pet_task"
              )
          ).rejects.toThrow();
        });

        it("should fail if the checkpoint_id is missing", async () => {
          const missingCheckpointIdConfig: RunnableConfig = {
            ...configArgument,
            configurable: Object.fromEntries(
              Object.entries(configArgument.configurable ?? {}).filter(
                ([key]) => key !== "checkpoint_id"
              )
            ),
          };

          await expect(
            async () =>
              await saver.putWrites(
                missingCheckpointIdConfig,
                [["animals", "dog"]],
                "pet_task"
              )
          ).rejects.toThrow();
        });
      });
    });
  });
}
