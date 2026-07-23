import { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import {
  CallbackManager,
  ensureHandler,
  type Callbacks,
} from "@langchain/core/callbacks/manager";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { LangGraphRunnableConfig } from "../runnable_types.js";
import {
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_READ,
  CONFIG_KEY_SCRATCHPAD,
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
  "interrupt",
  "context",
  "interruptBefore",
  "interruptAfter",
  "checkpointDuring",
  "durability",
  "signal",
  "heartbeat",
  "executionInfo",
  "serverInfo",
  "control",
];

const DEFAULT_RECURSION_LIMIT = 25;
export const PROPAGATE_TO_METADATA = new Set([
  "thread_id",
  "checkpoint_id",
  "checkpoint_ns",
  "task_id",
  "run_id",
  "assistant_id",
  "graph_id",
]);

export function propagateConfigurableToMetadata(
  configurable?: Record<string, unknown>,
  metadata?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!configurable) {
    return metadata;
  }
  const result = metadata ?? {};
  for (const key of PROPAGATE_TO_METADATA) {
    if (key in result) {
      continue;
    }
    const value = configurable[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Drop langgraph's internal `seq:step*` bookkeeping tags.
 *
 * `seq:step:N` tags are added internally to mark sequence steps; everything
 * else (user-supplied tags and any other framework tags) is kept. Returns the
 * surviving tags, or `undefined` if none remain. Shared by the stream handlers
 * (e.g. {@link mapDebugTasks}) so the same tag set is surfaced consistently.
 */
export function filterToUserTags(
  tags: readonly string[] | undefined
): string[] | undefined {
  if (tags == null || tags.length === 0) return undefined;
  const filtered = tags.filter((tag) => !tag.startsWith("seq:step"));
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Merge two `callbacks` values across configs.
 *
 * A `callbacks` value may be `undefined`, an array of handlers, or a
 * {@link CallbackManager}, so merging two of them has six cases. This
 * mirrors the callbacks branch of langchain-core's `mergeConfigs` and
 * langgraph's `_merge_callbacks`, so a handler bound via
 * `.withConfig({ callbacks: [...] })` is preserved when a later config
 * (e.g. `streamEvents` injecting its own internal handler) is merged on
 * top instead of overwriting it.
 */
function mergeCallbacks(
  base: Callbacks | undefined,
  provided: Callbacks | undefined
): Callbacks | undefined {
  if (provided === undefined) return base;
  if (base === undefined) {
    return Array.isArray(provided) ? [...provided] : provided.copy();
  }
  if (Array.isArray(provided)) {
    if (Array.isArray(base)) return base.concat(provided);
    // base is a manager
    const manager = base.copy();
    for (const callback of provided) {
      manager.addHandler(ensureHandler(callback), true);
    }
    return manager;
  }
  // provided is a manager
  if (Array.isArray(base)) {
    const manager = provided.copy();
    for (const callback of base) {
      manager.addHandler(ensureHandler(callback), true);
    }
    return manager;
  }
  // both are managers
  return new CallbackManager(provided._parentRunId, {
    handlers: base.handlers.concat(provided.handlers),
    inheritableHandlers: base.inheritableHandlers.concat(
      provided.inheritableHandlers
    ),
    tags: Array.from(new Set(base.tags.concat(provided.tags))),
    inheritableTags: Array.from(
      new Set(base.inheritableTags.concat(provided.inheritableTags))
    ),
    metadata: { ...base.metadata, ...provided.metadata },
    inheritableMetadata: {
      ...base.inheritableMetadata,
      ...provided.inheritableMetadata,
    },
  });
}

/**
 * True when the caller is starting a fresh top-level run (invoke-time
 * `thread_id`, no active nesting keys). In that case the ambient `configurable`
 * from `AsyncLocalStorage` cannot be trusted per-key — it may belong to another
 * concurrent invocation on a shared singleton agent (scratchpad/task-input as
 * well as arbitrary user keys like `tenant_id`/`user_id`). The whole ambient
 * `configurable` is therefore ignored; any value the caller actually wants for
 * this run arrives through the explicit (bound + invoke-time) configs instead.
 *
 * Only the last caller-supplied config is treated as invoke-time options.
 * Earlier entries are graph-bound defaults from `.withConfig()` / compile and
 * must not count — a child graph bound with `thread_id` and invoked from a
 * parent task without a fresh config still needs ambient nesting keys from ALS.
 */
function isRootLevelExplicitInvoke(
  configs: (LangGraphRunnableConfig | undefined)[]
): boolean {
  let invokeConfig: LangGraphRunnableConfig | undefined;
  for (let i = configs.length - 1; i >= 0; i -= 1) {
    if (configs[i] !== undefined) {
      invokeConfig = configs[i];
      break;
    }
  }
  const hasInvokeTimeThreadId =
    invokeConfig?.configurable?.thread_id !== undefined;

  const hasExplicitNesting = configs.some(
    (c) => c?.configurable?.[CONFIG_KEY_READ] !== undefined
  );

  const ambientConfigurable =
    AsyncLocalStorageProviderSingleton.getRunnableConfig()?.configurable;
  const hasAmbientNesting =
    ambientConfigurable?.[CONFIG_KEY_READ] !== undefined;

  return hasInvokeTimeThreadId && !hasExplicitNesting && !hasAmbientNesting;
}

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

  const skipImplicitConfigurable = isRootLevelExplicitInvoke(configs);

  const implicitConfig: RunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (implicitConfig !== undefined) {
    for (const [k, v] of Object.entries(implicitConfig)) {
      if (v !== undefined) {
        // Stale-ALS root invoke: ignore the ambient `configurable` entirely,
        // since its keys may belong to another concurrent invocation.
        if (k === "configurable" && skipImplicitConfigurable) {
          continue;
        }
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
      if (v === undefined || !CONFIG_KEYS.includes(k)) {
        continue;
      }

      // Merge (rather than overwrite) the fields that compose across
      // multiple configs, matching langgraph's `merge_configs` /
      // langchain-core's `mergeConfigs`. Without this, a value bound via
      // `.withConfig({...})` is silently dropped whenever a later config
      // (e.g. invoke-time, or `streamEvents`' internal handler) supplies
      // any other key in the same field. Later configs still win per key
      // on collision.
      if (k === "configurable") {
        empty.configurable = {
          ...(empty.configurable as Record<string, unknown> | undefined),
          ...(v as Record<string, unknown>),
        };
      } else if (k === "metadata") {
        empty.metadata = {
          ...(empty.metadata as Record<string, unknown> | undefined),
          ...(v as Record<string, unknown>),
        };
      } else if (k === "tags") {
        // Plain concat (matches langgraph's `merge_configs`): no dedup,
        // no sort.
        empty.tags = [
          ...((empty.tags as string[] | undefined) ?? []),
          ...(v as string[]),
        ];
      } else if (k === "callbacks") {
        empty.callbacks = mergeCallbacks(empty.callbacks, v as Callbacks);
      } else {
        empty[k as keyof LangGraphRunnableConfig] = v;
      }
    }
  }

  empty.metadata =
    propagateConfigurableToMetadata(
      empty.configurable as Record<string, unknown> | undefined,
      empty.metadata as Record<string, unknown> | undefined
    ) ?? {};
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
 * A helper utility function that returns the input for the currently executing
 * task.
 *
 * Note: When called without arguments, this relies on `node:async_hooks` /
 * `AsyncLocalStorage`, which is available in many JavaScript environments
 * (Node.js, Deno, Cloudflare Workers) but not in web browsers. In environments
 * without `AsyncLocalStorage` support, pass the `config` that your node/tool
 * function receives directly, e.g. `getCurrentTaskInput(config)`.
 *
 * Tip: Inside a tool run by a `ToolNode`, prefer reading graph state from
 * `runtime.state` on the second tool argument (typed as `ToolRuntime` from
 * `@langchain/core/tools`). It works in every runtime, including web browsers.
 *
 * @param config - Optional {@link LangGraphRunnableConfig} to read the task
 * input from. Provide this when running in an environment without
 * `AsyncLocalStorage` support (e.g. web browsers).
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
