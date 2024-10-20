import { specTest } from "../spec/index.js";
import { initializer } from "./postgresInitializer.js";
import { isCI, osHasSupportedContainerRuntime } from "./utils.js";

if (osHasSupportedContainerRuntime() || !isCI()) {
  specTest(initializer);
} else {
  it.skip(`${initializer.saverName} skipped in CI because no container runtime is available`, () => {});
}
