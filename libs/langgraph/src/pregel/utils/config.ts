import { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { LangGraphRunnableConfig } from "../runnable_types.js";
import {
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
} from "../../constants.js";

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
  "interruptBefore",
  "interruptAfter",
  "signal",
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

/**
 * A helper utility function that returns the {@link BaseStore} that was set when the graph was initialized
 *
 * @returns a reference to the {@link BaseStore} that was set when the graph was initialized
 */
export function getStore(): BaseStore | undefined {
  const config: LangGraphRunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return config?.store;
}

/**
 * A helper utility function that returns the {@link LangGraphRunnableConfig#writer} if "custom" stream mode is enabled, otherwise undefined
 *
 * @returns a reference to the {@link LangGraphRunnableConfig#writer} if "custom" stream mode is enabled, otherwise undefined
 */
export function getWriter(): ((chunk: unknown) => void) | undefined {
  const config: LangGraphRunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return config?.configurable?.writer;
}

export function getConfig(): LangGraphRunnableConfig {
  return AsyncLocalStorageProviderSingleton.getRunnableConfig();
}

export function recastCheckpointNamespace(namespace: string): string {
  return namespace
    .split(CHECKPOINT_NAMESPACE_SEPARATOR)
    .filter((part) => !part.match(/^\d+$/))
    .map((part) => part.split(CHECKPOINT_NAMESPACE_END)[0])
    .join(CHECKPOINT_NAMESPACE_SEPARATOR);
}

export function getParentCheckpointNamespace(namespace: string): string {
  const parts = namespace.split(CHECKPOINT_NAMESPACE_SEPARATOR);
  while (parts.length > 1 && !parts[parts.length - 1].match(/^\d+$/)) {
    parts.pop();
  }
  return parts.join(CHECKPOINT_NAMESPACE_SEPARATOR);
}
