import { specTest } from "../spec/index.js";
import { deltaChannelHistoryTests } from "../spec/delta_channel_history.js";
import { initializer } from "./redis_initializer.js";
import { isSkippedCIEnvironment } from "./utils.js";

if (isSkippedCIEnvironment()) {
  it.skip(`${initializer.checkpointerName} skipped in CI because no container runtime is available`, () => {});
} else {
  specTest(initializer);
  deltaChannelHistoryTests(initializer);
}
