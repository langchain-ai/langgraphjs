import { type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { describe, beforeAll, afterAll } from "@jest/globals";

import { CheckpointSaverTestInitializer, TestTypeFilter } from "../types.js";
import { putTests } from "./put.js";
import { putWritesTests } from "./putWrites.js";
import { getTupleTests } from "./getTuple.js";
import { listTests } from "./list.js";

const testTypeMap = {
  getTuple: getTupleTests,
  list: listTests,
  put: putTests,
  putWrites: putWritesTests,
};

/**
 * Kicks off a test suite to validate that the provided checkpoint saver conforms to the specification for classes that extend @see BaseCheckpointSaver.
 * @param initializer A @see CheckpointSaverTestInitializer, providing methods for setup and cleanup of the test, and for creation of the saver instance being tested.
 * @param filters If specified, only the test suites in this list will be executed.
 */
export function specTest<T extends BaseCheckpointSaver>(
  initializer: CheckpointSaverTestInitializer<T>,
  filters?: TestTypeFilter[]
) {
  beforeAll(async () => {
    await initializer.beforeAll?.();
  }, initializer.beforeAllTimeout ?? 10000);

  afterAll(async () => {
    await initializer.afterAll?.();
  });

  describe(initializer.saverName, () => {
    if (!filters || filters.length === 0) {
      putTests(initializer);
      putWritesTests(initializer);
      getTupleTests(initializer);
      listTests(initializer);
    } else {
      for (const testType of filters) {
        testTypeMap[testType](initializer);
      }
    }
  });
}

export { getTupleTests, listTests, putTests, putWritesTests };
