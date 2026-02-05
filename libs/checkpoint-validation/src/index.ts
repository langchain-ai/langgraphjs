import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { specTest } from "./spec/index.js";
import type { CheckpointerTestInitializer } from "./types.js";

export type { CheckpointerTestInitializer as CheckpointSaverTestInitializer } from "./types.js";
export {
  getTupleTests,
  listTests,
  putTests,
  putWritesTests,
  specTest,
} from "./spec/index.js";

export function validate<CheckpointSaverT extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<CheckpointSaverT>
) {
  specTest(initializer);
}
