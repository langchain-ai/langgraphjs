import { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";

export interface CheckpointSaverTestInitializer<
  CheckpointSaverT extends BaseCheckpointSaver
> {
  /**
   * The name of the checkpoint saver being tested. This will be used to identify the saver in test output.
   */
  saverName: string;

  /**
   * Called once before any tests are run. Use this to perform any setup that your checkpoint saver may require, like
   * starting docker containers, etc.
   */
  beforeAll?(): void | Promise<void>;

  /**
   * Optional timeout for beforeAll. Useful for test setups that might take a while to complete, e.g. due to needing to
   * pull a docker container.
   *
   * @default 10000
   */
  beforeAllTimeout?: number;

  /**
   * Called once after all tests are run. Use this to perform any infrastructure cleanup that your checkpoint saver may
   * require, like tearing down docker containers, etc.
   */
  afterAll?(): void | Promise<void>;

  /**
   * Called before each set of validations is run, prior to calling @see createSaver. Use this to modify the @see
   * RunnableConfig that will be used during the test, used to include any additional configuration that your
   * checkpoint saver may require.
   *
   * @param config The @see RunnableConfig that will be used during the test.
   * @returns an instance of @see RunnableConfig (or a promise that resolves to one) to be merged with the original
   * config for use during the test execution.
   */
  configure?(config: RunnableConfig): RunnableConfig | Promise<RunnableConfig>;

  /**
   * Called before each set of validations is run, after @see configure has been called. The checkpoint saver returned
   * will be used during test execution.
   *
   * @param config The @see RunnableConfig that will be used during the test. Can be used for constructing the saver,
   * if required.
   * @returns A new saver, or promise that resolves to a new saver.
   */
  createSaver(
    config: RunnableConfig
  ): CheckpointSaverT | Promise<CheckpointSaverT>;

  /**
   * Called after each set of validations is run. Use this to clean up any resources that your checkpoint saver may
   * have been using. This should include cleaning up any state that the saver wrote during the tests that just ran.
   *
   * @param saver The @see BaseCheckpointSaver that was used during the test.
   * @param config The @see RunnableConfig that was used during the test.
   */
  destroySaver?(
    saver: CheckpointSaverT,
    config: RunnableConfig
  ): void | Promise<void>;
}

export const checkpointSaverTestInitializerSchema = z.object({
  saverName: z.string(),
  beforeAll: z
    .function()
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
  beforeAllTimeout: z.number().default(10000).optional(),
  afterAll: z
    .function()
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
  configure: z
    .function()
    .args(z.custom<RunnableConfig>())
    .returns(
      z.custom<RunnableConfig>().or(z.promise(z.custom<RunnableConfig>()))
    )
    .optional(),
  createSaver: z
    .function()
    .args(z.custom<RunnableConfig>())
    .returns(
      z
        .custom<BaseCheckpointSaver>()
        .or(z.promise(z.custom<BaseCheckpointSaver>()))
    ),
  destroySaver: z
    .function()
    .args(z.custom<BaseCheckpointSaver>(), z.custom<RunnableConfig>())
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
});

export type TestTypeFilter = "getTuple" | "list" | "put" | "putWrites";

export type GlobalThis = typeof globalThis & {
  __langgraph_checkpoint_validation_initializer?: CheckpointSaverTestInitializer<BaseCheckpointSaver>;
  __langgraph_checkpoint_validation_filters?: TestTypeFilter[];
};
