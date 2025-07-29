import { type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

import { CheckpointerTestInitializer, TestTypeFilter } from "../types.js";
import { putTests } from "./put.js";
import { putWritesTests } from "./put_writes.js";
import { getTupleTests } from "./get_tuple.js";
import { listTests } from "./list.js";
import { deleteThreadTests } from "./delete_thread.js";

const testTypeMap = {
  getTuple: getTupleTests,
  list: listTests,
  put: putTests,
  putWrites: putWritesTests,
  deleteThread: deleteThreadTests,
};

/**
 * Kicks off a test suite to validate that the provided checkpointer conforms to the specification for classes that
 * extend @see BaseCheckpointSaver.
 *
 * @param initializer A @see CheckpointerTestInitializer, providing methods for setup and cleanup of the test,
 * and for creation of the checkpointer instance being tested.
 * @param filters If specified, only the test suites in this list will be executed.
 */
export function specTest<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>,
  filters?: TestTypeFilter[]
) {
  beforeAll(async () => {
    await initializer.beforeAll?.();
  }, initializer.beforeAllTimeout ?? 10000);

  afterAll(async () => {
    await initializer.afterAll?.();
  });

  describe(initializer.checkpointerName, () => {
    if (!filters || filters.length === 0) {
      putTests(initializer);
      putWritesTests(initializer);
      getTupleTests(initializer);
      listTests(initializer);
      deleteThreadTests(initializer);
    } else {
      for (const testType of filters) {
        testTypeMap[testType](initializer);
      }
    }
  });
}

export { getTupleTests, listTests, putTests, putWritesTests };
