import { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { LangGraphRunnableConfig } from "../runnable_types.js";

const COPIABLE_KEYS = ["tags", "metadata", "callbacks", "configurable"];

const CONFIG_KEYS = [
  "tags",
  "metadata",
  "callbacks",
  "runName",
  "maxConcurrency",
  "recursionLimit",
  "configurable",
  "runId",
  "outputKeys",
  "streamMode",
  "store",
  "writer",
];

const DEFAULT_RECURSION_LIMIT = 25;

export function ensureLangGraphConfig(
  ...configs: (LangGraphRunnableConfig | undefined)[]
): RunnableConfig {
  const empty: LangGraphRunnableConfig = {
    tags: [],
    metadata: {},
    callbacks: undefined,
    recursionLimit: DEFAULT_RECURSION_LIMIT,
    configurable: {},
  };

  const implicitConfig: RunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (implicitConfig !== undefined) {
    for (const [k, v] of Object.entries(implicitConfig)) {
      if (v !== undefined) {
        if (COPIABLE_KEYS.includes(k)) {
          let copiedValue;
          if (Array.isArray(v)) {
            copiedValue = [...v];
          } else if (typeof v === "object") {
            if (
              k === "callbacks" &&
              "copy" in v &&
              typeof v.copy === "function"
            ) {
              copiedValue = v.copy();
            } else {
              copiedValue = { ...v };
            }
          } else {
            copiedValue = v;
          }
          empty[k as keyof RunnableConfig] = copiedValue;
        } else {
          empty[k as keyof RunnableConfig] = v;
        }
      }
    }
  }

  for (const config of configs) {
    if (config === undefined) {
      continue;
    }

    for (const [k, v] of Object.entries(config)) {
      if (v !== undefined && CONFIG_KEYS.includes(k)) {
        empty[k as keyof LangGraphRunnableConfig] = v;
      }
    }
  }

  for (const [key, value] of Object.entries(empty.configurable!)) {
    empty.metadata = empty.metadata ?? {};
    if (
      !key.startsWith("__") &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") &&
      !(key in empty.metadata!)
    ) {
      empty.metadata[key] = value;
    }
  }

  return empty;
}
