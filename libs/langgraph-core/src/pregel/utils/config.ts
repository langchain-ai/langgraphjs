import { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { LangGraphRunnableConfig } from "../runnable_types.js";
import {
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_SCRATCHPAD,
} from "../../constants.js";

const COPIABLE_KEYS = new Set([
  "tags",
  "metadata",
  "callbacks",
  "configurable",
]);

const CONFIG_KEYS = new Set([
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
  "interrupt",
  "context",
  "interruptBefore",
  "interruptAfter",
  "checkpointDuring",
  "durability",
  "signal",
]);

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
    for (const k in implicitConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (implicitConfig as Record<string, any>)[k];
      if (v !== undefined) {
        if (COPIABLE_KEYS.has(k)) {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (empty as Record<string, any>)[k] = copiedValue;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (empty as Record<string, any>)[k] = v;
        }
      }
    }
  }

  for (const config of configs) {
    if (config === undefined) {
      continue;
    }

    for (const k in config) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (config as Record<string, any>)[k];
      if (v !== undefined && CONFIG_KEYS.has(k)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (empty as Record<string, any>)[k] = v;
      }
    }
  }

  for (const key in empty.configurable!) {
    const value = empty.configurable![key];
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
export function getStore(
  config?: LangGraphRunnableConfig
): BaseStore | undefined {
  const runConfig: LangGraphRunnableConfig =
    config ?? AsyncLocalStorageProviderSingleton.getRunnableConfig();

  if (runConfig === undefined) {
    throw new Error(
      [
        "Config not retrievable. This is likely because you are running in an environment without support for AsyncLocalStorage.",
        "If you're running `getStore` in such environment, pass the `config` from the node function directly.",
      ].join("\n")
    );
  }

  return runConfig?.store;
}

/**
 * A helper utility function that returns the {@link LangGraphRunnableConfig#writer} if "custom" stream mode is enabled, otherwise undefined.
 *
 * @returns a reference to the {@link LangGraphRunnableConfig#writer} if "custom" stream mode is enabled, otherwise undefined
 */
export function getWriter(
  config?: LangGraphRunnableConfig
): ((chunk: unknown) => void) | undefined {
  const runConfig: LangGraphRunnableConfig =
    config ?? AsyncLocalStorageProviderSingleton.getRunnableConfig();

  if (runConfig === undefined) {
    throw new Error(
      [
        "Config not retrievable. This is likely because you are running in an environment without support for AsyncLocalStorage.",
        "If you're running `getWriter` in such environment, pass the `config` from the node function directly.",
      ].join("\n")
    );
  }

  return runConfig?.writer || runConfig?.configurable?.writer;
}

/**
 * A helper utility function that returns the {@link LangGraphRunnableConfig} that was set when the graph was initialized.
 *
 * Note: This only works when running in an environment that supports node:async_hooks and AsyncLocalStorage. If you're running this in a
 * web environment, access the LangGraphRunnableConfig from the node function directly.
 *
 * @returns the {@link LangGraphRunnableConfig} that was set when the graph was initialized
 */
export function getConfig(): LangGraphRunnableConfig {
  return AsyncLocalStorageProviderSingleton.getRunnableConfig();
}

/**
 * A helper utility function that returns the input for the currently executing task
 *
 * @returns the input for the currently executing task
 */
export function getCurrentTaskInput<T = unknown>(
  config?: LangGraphRunnableConfig
): T {
  const runConfig: LangGraphRunnableConfig =
    config ?? AsyncLocalStorageProviderSingleton.getRunnableConfig();

  if (runConfig === undefined) {
    throw new Error(
      [
        "Config not retrievable. This is likely because you are running in an environment without support for AsyncLocalStorage.",
        "If you're running `getCurrentTaskInput` in such environment, pass the `config` from the node function directly.",
      ].join("\n")
    );
  }

  if (
    runConfig.configurable?.[CONFIG_KEY_SCRATCHPAD]?.currentTaskInput ===
    undefined
  ) {
    throw new Error("BUG: internal scratchpad not initialized.");
  }

  return runConfig!.configurable![CONFIG_KEY_SCRATCHPAD]!.currentTaskInput as T;
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
  while (parts.length > 1 && parts[parts.length - 1].match(/^\d+$/)) {
    parts.pop();
  }
  return parts.slice(0, -1).join(CHECKPOINT_NAMESPACE_SEPARATOR);
}
