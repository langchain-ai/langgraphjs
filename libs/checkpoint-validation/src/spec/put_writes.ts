import {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  uuid6,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { CheckpointerTestInitializer } from "../types.js";
import { initialCheckpointTuple } from "../test_utils.js";

export function putWritesTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>
) {
  describe(`${initializer.checkpointerName}#putWrites`, () => {
    let checkpointer: T;
    let thread_id: string;
    let checkpoint_id: string;

    beforeEach(async () => {
      thread_id = uuid6(-3);
      checkpoint_id = uuid6(-3);

      checkpointer = await initializer.createCheckpointer();
    });

    afterEach(async () => {
      await initializer.destroyCheckpointer?.(checkpointer);
    });

    describe.each(["root", "child"])("namespace: %s", (namespace) => {
      const checkpoint_ns = namespace === "root" ? "" : namespace;
      let checkpoint: Checkpoint;
      let metadata: CheckpointMetadata | undefined;

      describe("success cases", () => {
        let returnedConfig!: RunnableConfig;
        let savedCheckpointTuple: CheckpointTuple | undefined;

        beforeEach(async () => {
          ({ checkpoint, metadata } = initialCheckpointTuple({
            thread_id,
            checkpoint_ns,
            checkpoint_id,
          }));

          // ensure the test checkpoint does not already exist
          const existingCheckpoint = await checkpointer.get({
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id,
            },
          });
          expect(existingCheckpoint).toBeUndefined(); // our test checkpoint should not exist yet

          returnedConfig = await checkpointer.put(
            {
              configurable: {
                thread_id,
                checkpoint_ns,
              },
            },
            checkpoint,
            metadata!,
            {} /* not sure what to do about newVersions, as it's unused */
          );

          await checkpointer.putWrites(
            returnedConfig,
            [["animals", "dog"]],
            "pet_task"
          );

          savedCheckpointTuple = await checkpointer.getTuple(returnedConfig);

          // fail here if `put` or `getTuple` is broken so we don't get a bunch of noise from the actual test cases below
          expect(savedCheckpointTuple).not.toBeUndefined();
          expect(savedCheckpointTuple?.checkpoint).toEqual(checkpoint);
          expect(savedCheckpointTuple?.metadata).toEqual(metadata);
          expect(savedCheckpointTuple?.config).toEqual({
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id,
            },
          });
        });

        it("should store writes to the checkpoint", async () => {
          expect(savedCheckpointTuple?.pendingWrites).toEqual([
            ["pet_task", "animals", "dog"],
          ]);
        });
      });

      describe("failure cases", () => {
        it("should fail if the thread_id is missing", async () => {
          const missingThreadIdConfig = {
            configurable: {
              checkpoint_ns,
              checkpoint_id,
            },
          };

          await expect(
            async () =>
              await checkpointer.putWrites(
                missingThreadIdConfig,
                [["animals", "dog"]],
                "pet_task"
              )
          ).rejects.toThrow();
        });

        it("should fail if the checkpoint_id is missing", async () => {
          const missingCheckpointIdConfig: RunnableConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
            },
          };

          await expect(
            async () =>
              await checkpointer.putWrites(
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
