import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { specTest } from "./spec/index.js";
import type { CheckpointSaverTestInitializer } from "./types.js";

export { CheckpointSaverTestInitializer } from "./types.js";
export {
  getTupleTests,
  listTests,
  putTests,
  putWritesTests,
  specTest,
} from "./spec/index.js";

export function validate<CheckpointSaverT extends BaseCheckpointSaver>(
  initializer: CheckpointSaverTestInitializer<CheckpointSaverT>
) {
  specTest(initializer);
}
