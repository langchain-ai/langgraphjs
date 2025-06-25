import { it } from "vitest";
import { specTest } from "../spec/index.js";
import { initializer } from "./mongodb_initializer.js";
import { isSkippedCIEnvironment } from "./utils.js";

if (isSkippedCIEnvironment()) {
  it.skip(`${initializer.checkpointerName} skipped in CI because no container runtime is available`, () => {});
} else {
  specTest(initializer);
}
