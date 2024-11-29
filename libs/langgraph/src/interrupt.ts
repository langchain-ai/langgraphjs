import { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { GraphInterrupt } from "./errors.js";
import { CONFIG_KEY_RESUME_VALUE, MISSING } from "./constants.js";

export function interrupt<I = unknown, R = unknown>(value: I): R {
  const config: RunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error("Called interrupt() outside the context of a graph.");
  }
  const resume = config.configurable?.[CONFIG_KEY_RESUME_VALUE];
  if (resume !== MISSING) {
    return resume as R;
  } else {
    throw new GraphInterrupt([{ value, when: "during" }]);
  }
}
