import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { LangGraphRunnableConfig } from "./pregel/runnable_types.js";

export function writer<T>(chunk: T): void {
  const config: LangGraphRunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error("Called interrupt() outside the context of a graph.");
  }

  const conf = config.configurable;
  if (!conf) {
    throw new Error("No configurable found in config");
  }

  return conf.writer?.(chunk);
}

export type InferWriterType<T> = T extends typeof writer<infer C> ? C : any; // eslint-disable-line @typescript-eslint/no-explicit-any
