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
import { putTuples } from "./util.js";
import { it_skipForSomeModules } from "../testUtils.js";

export function putTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointSaverTestInitializer<T>
) {
  describe(`${initializer.saverName}#put`, () => {
    let saver: T;
    let initializerConfig: RunnableConfig;
    let thread_id: string;
    let checkpoint_id1: string;

    beforeEach(async () => {
      thread_id = uuid6(-3);
      checkpoint_id1 = uuid6(-3);

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
      let checkpointStoredWithoutIdInConfig: Checkpoint;
      let metadataStoredWithoutIdInConfig: CheckpointMetadata | undefined;

      describe("success cases", () => {
        let basicPutReturnedConfig: RunnableConfig;
        let basicPutRoundTripTuple: CheckpointTuple | undefined;

        beforeEach(async () => {
          ({
            checkpoint: checkpointStoredWithoutIdInConfig,
            metadata: metadataStoredWithoutIdInConfig,
          } = initialCheckpointTuple({
            config: initializerConfig,
            checkpoint_id: checkpoint_id1,
            checkpoint_ns,
          }));

          configArgument = mergeConfigs(initializerConfig, {
            configurable: { checkpoint_ns },
          });

          // validate assumptions - the test checkpoints must not already exist
          const existingCheckpoint1 = await saver.get(
            mergeConfigs(configArgument, {
              configurable: {
                checkpoint_id: checkpoint_id1,
              },
            })
          );

          const existingCheckpoint2 = await saver.get(
            mergeConfigs(configArgument, {
              configurable: {
                checkpoint_id: checkpoint_id1,
              },
            })
          );

          expect(existingCheckpoint1).toBeUndefined();
          expect(existingCheckpoint2).toBeUndefined();

          // set up
          // call put without the `checkpoint_id` in the config
          basicPutReturnedConfig = await saver.put(
            mergeConfigs(configArgument, {
              configurable: {
                // adding this to ensure that additional fields are not stored in the checkpoint tuple
                canary: "tweet",
              },
            }),
            checkpointStoredWithoutIdInConfig,
            metadataStoredWithoutIdInConfig!,
            {}
          );

          basicPutRoundTripTuple = await saver.getTuple(
            mergeConfigs(configArgument, basicPutReturnedConfig)
          );
        });

        it("should return a config with a 'configurable' property", () => {
          expect(basicPutReturnedConfig.configurable).toBeDefined();
        });

        it("should return a config with only thread_id, checkpoint_ns, and checkpoint_id in the configurable", () => {
          expect(
            Object.keys(basicPutReturnedConfig.configurable ?? {})
          ).toEqual(
            expect.arrayContaining([
              "thread_id",
              "checkpoint_ns",
              "checkpoint_id",
            ])
          );
        });

        it("should return config with matching thread_id", () => {
          expect(basicPutReturnedConfig.configurable?.thread_id).toEqual(
            thread_id
          );
        });

        it("should return config with matching checkpoint_id", () => {
          expect(basicPutReturnedConfig.configurable?.checkpoint_id).toEqual(
            checkpointStoredWithoutIdInConfig.id
          );
        });

        it("should return config with matching checkpoint_ns", () => {
          expect(basicPutReturnedConfig.configurable?.checkpoint_ns).toEqual(
            checkpoint_ns
          );
        });

        it("should result in a retrievable checkpoint tuple", () => {
          expect(basicPutRoundTripTuple).not.toBeUndefined();
        });

        it("should store the checkpoint without alteration", () => {
          expect(basicPutRoundTripTuple?.checkpoint).toEqual(
            checkpointStoredWithoutIdInConfig
          );
        });

        it("should store the metadata without alteration", () => {
          expect(basicPutRoundTripTuple?.metadata).toEqual(
            metadataStoredWithoutIdInConfig
          );
        });
      });

      describe("failure cases", () => {
        it("should fail if config.configurable is missing", async () => {
          const missingConfigurableConfig: RunnableConfig = {
            ...configArgument,
            configurable: undefined,
          };

          await expect(
            async () =>
              await saver.put(
                missingConfigurableConfig,
                checkpointStoredWithoutIdInConfig,
                metadataStoredWithoutIdInConfig!,
                {}
              )
          ).rejects.toThrow();
        });

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
              await saver.put(
                missingThreadIdConfig,
                checkpointStoredWithoutIdInConfig,
                metadataStoredWithoutIdInConfig!,
                {}
              )
          ).rejects.toThrow();
        });
      });
    });

    it_skipForSomeModules(initializer.saverName, {
      // TODO: MemorySaver throws instead of defaulting to empty namespace
      // see: https://github.com/langchain-ai/langgraphjs/issues/591
      MemorySaver: "TODO: throws instead of defaulting to empty namespace",
      // TODO: SqliteSaver stores with undefined namespace instead of empty namespace
      // see: https://github.com/langchain-ai/langgraphjs/issues/592
      "@langchain/langgraph-checkpoint-sqlite":
        "TODO: SqliteSaver stores config with no checkpoint_ns instead of default namespace",
    })(
      "should default to empty namespace if the checkpoint namespace is missing from config.configurable",
      async () => {
        const missingNamespaceConfig: RunnableConfig = {
          ...initializerConfig,
          configurable: Object.fromEntries(
            Object.entries(initializerConfig.configurable ?? {}).filter(
              ([key]) => key !== "checkpoint_ns"
            )
          ),
        };

        const { checkpoint, metadata } = initialCheckpointTuple({
          config: missingNamespaceConfig,
          checkpoint_id: checkpoint_id1,
          checkpoint_ns: "",
        });

        const returnedConfig = await saver.put(
          missingNamespaceConfig,
          checkpoint,
          metadata!,
          {}
        );

        expect(returnedConfig).not.toBeUndefined();
        expect(returnedConfig?.configurable).not.toBeUndefined();
        expect(returnedConfig?.configurable?.checkpoint_ns).not.toBeUndefined();
        expect(returnedConfig?.configurable?.checkpoint_ns).toEqual("");
      }
    );

    it_skipForSomeModules(initializer.saverName, {
      // TODO: all of the savers below store full channel_values on every put, rather than storing deltas
      // see: https://github.com/langchain-ai/langgraphjs/issues/593
      // see: https://github.com/langchain-ai/langgraphjs/issues/594
      // see: https://github.com/langchain-ai/langgraphjs/issues/595
      MemorySaver: "TODO: MemorySaver doesn't store channel deltas",
      "@langchain/langgraph-checkpoint-mongodb":
        "TODO: MongoDBSaver doesn't store channel deltas",
      "@langchain/langgraph-checkpoint-sqlite":
        "TODO: SQLiteSaver doesn't store channel deltas",
    })(
      "should only store channel_values that have changed (based on newVersions)",
      async () => {
        const newVersions = [{}, { foo: 1 }, { foo: 1, baz: 1 }] as Record<
          string,
          number | string
        >[];

        const generatedPuts = newVersions.map((newVersions) => ({
          tuple: initialCheckpointTuple({
            config: initializerConfig,
            checkpoint_id: uuid6(-3),
            checkpoint_ns: "",
            channel_values: {
              foo: "bar",
              baz: "qux",
            },
          }),
          writes: [],
          newVersions,
        }));

        const storedTuples: CheckpointTuple[] = [];
        for await (const tuple of putTuples(
          saver,
          generatedPuts,
          initializerConfig
        )) {
          storedTuples.push(tuple);
        }

        const expectedChannelValues = [
          {},
          {
            foo: "bar",
          },
          {
            foo: "bar",
            baz: "qux",
          },
        ];

        expect(
          storedTuples.map((tuple) => tuple.checkpoint.channel_values)
        ).toEqual(expectedChannelValues);
      }
    );
  });
}
