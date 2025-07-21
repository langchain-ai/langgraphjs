import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";

export interface CheckpointerTestInitializer<
  CheckpointerT extends BaseCheckpointSaver
> {
  /**
   * The name of the checkpointer being tested. This will be used to identify the checkpointer in test output.
   */
  checkpointerName: string;

  /**
   * Called once before any tests are run. Use this to perform any setup that your checkpoint checkpointer may require, like
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
   * Called once after all tests are run. Use this to perform any infrastructure cleanup that your checkpointer may
   * require, like tearing down docker containers, etc.
   */
  afterAll?(): void | Promise<void>;

  /**
   * Called before each set of validations is run. The checkpointer returned will be used during test execution.
   *
   * @returns A new checkpointer, or promise that resolves to a new checkpointer.
   */
  createCheckpointer(): CheckpointerT | Promise<CheckpointerT>;

  /**
   * Called after each set of validations is run. Use this to clean up any resources that your checkpointer may
   * have been using. This should include cleaning up any state that the checkpointer wrote during the tests that just ran.
   *
   * @param checkpointer The @see BaseCheckpointSaver that was used during the test.
   */
  destroyCheckpointer?(checkpointer: CheckpointerT): void | Promise<void>;
}

export const checkpointerTestInitializerSchema = z.object({
  checkpointerName: z.string(),
  beforeAll: z
    .function()
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
  beforeAllTimeout: z.number().default(10000).optional(),
  afterAll: z
    .function()
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
  createCheckpointer: z
    .function()
    .returns(
      z
        .custom<BaseCheckpointSaver>()
        .or(z.promise(z.custom<BaseCheckpointSaver>()))
    ),
  destroyCheckpointer: z
    .function()
    .args(z.custom<BaseCheckpointSaver>())
    .returns(z.void().or(z.promise(z.void())))
    .optional(),
});

export const testTypeFilters = [
  "getTuple",
  "list",
  "put",
  "putWrites",
  "deleteThread",
] as const;

export type TestTypeFilter = (typeof testTypeFilters)[number];

export function isTestTypeFilter(value: string): value is TestTypeFilter {
  return testTypeFilters.includes(value as TestTypeFilter);
}

export function isTestTypeFilterArray(
  value: string[]
): value is TestTypeFilter[] {
  return value.every(isTestTypeFilter);
}
