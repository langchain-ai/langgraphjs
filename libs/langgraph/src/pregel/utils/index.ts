import { Callbacks } from "@langchain/core/callbacks/manager";
import { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { CONFIG_KEY_CHECKPOINT_MAP, START } from "../../constants.js";

export function getNullChannelVersion(currentVersions: ChannelVersions) {
  // Short circuit for commonly used channels such as __start__
  // (used by StateGraph)
  const startVersion = typeof currentVersions[START];
  if (startVersion === "number") return 0;
  if (startVersion === "string") return "";

  // Defer back to obtaining a first key from channel versions
  for (const key in currentVersions) {
    if (!Object.prototype.hasOwnProperty.call(currentVersions, key)) continue;
    const versionType = typeof currentVersions[key];
    if (versionType === "number") return 0;
    if (versionType === "string") return "";
    break;
  }

  return undefined;
}

export function getNewChannelVersions(
  previousVersions: ChannelVersions,
  currentVersions: ChannelVersions
): ChannelVersions {
  // Get new channel versions
  if (Object.keys(previousVersions).length > 0) {
    const nullVersion = getNullChannelVersion(currentVersions);
    return Object.fromEntries(
      Object.entries(currentVersions).filter(
        ([k, v]) => v > (previousVersions[k] ?? nullVersion)
      )
    );
  } else {
    return currentVersions;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _coerceToDict(value: any, defaultKey: string) {
  return value &&
    !Array.isArray(value) &&
    // eslint-disable-next-line no-instanceof/no-instanceof
    !(value instanceof Date) &&
    typeof value === "object"
    ? value
    : { [defaultKey]: value };
}

export type RetryPolicy = {
  /**
   * Amount of time that must elapse before the first retry occurs in milliseconds.
   * @default 500
   */
  initialInterval?: number;

  /**
   * Multiplier by which the interval increases after each retry.
   * @default 2
   */
  backoffFactor?: number;

  /**
   * Maximum amount of time that may elapse between retries in milliseconds.
   * @default 128000
   */
  maxInterval?: number;

  /**
   * Maximum amount of time that may elapse between retries.
   * @default 3
   */
  maxAttempts?: number;

  /** Whether to add random jitter to the interval between retries. */
  jitter?: boolean;

  /** A function that returns True for exceptions that should trigger a retry. */
  retryOn?: (e: any) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Whether to log a warning when a retry is attempted. Defaults to true. */
  logWarning?: boolean;
};

/**
 * Configuration for caching nodes.
 */
export type CachePolicy = {
  /**
   * A function used to generate a cache key from node's input.
   * @returns A key for the cache.
   */
  keyFunc?: (args: unknown[]) => string;

  /**
   * The time to live for the cache in seconds.
   * If not defined, the entry will never expire.
   */
  ttl?: number;
};

export function patchConfigurable(
  config: RunnableConfig | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: Record<string, any>
): RunnableConfig {
  if (config === null) {
    return { configurable: patch };
  } else if (config?.configurable === undefined) {
    return { ...config, configurable: patch };
  } else {
    return {
      ...config,
      configurable: { ...config.configurable, ...patch },
    };
  }
}

export function patchCheckpointMap(
  config: RunnableConfig,
  metadata?: CheckpointMetadata
): RunnableConfig {
  const parents = metadata?.parents ?? {};

  if (Object.keys(parents).length > 0) {
    return patchConfigurable(config, {
      [CONFIG_KEY_CHECKPOINT_MAP]: {
        ...parents,
        [config.configurable?.checkpoint_ns ?? ""]:
          config.configurable?.checkpoint_id,
      },
    });
  } else {
    return config;
  }
}

/**
 * Combine multiple abort signals into a single abort signal.
 * @param signals - The abort signals to combine.
 * @returns A combined abort signal and a dispose function to remove the abort listener if unused.
 */
export function combineAbortSignals(...x: (AbortSignal | undefined)[]): {
  signal: AbortSignal | undefined;
  dispose?: () => void;
} {
  const signals = [...new Set(x.filter((s) => s !== undefined))];

  if (signals.length === 0) {
    return { signal: undefined, dispose: undefined };
  }

  if (signals.length === 1) {
    return { signal: signals[0], dispose: undefined };
  }

  const combinedController = new AbortController();
  const listener = () => {
    combinedController.abort();
    signals.forEach((s) => s.removeEventListener("abort", listener));
  };

  signals.forEach((s) => s.addEventListener("abort", listener, { once: true }));

  if (signals.some((s) => s.aborted)) {
    combinedController.abort();
  }

  return {
    signal: combinedController.signal,
    dispose: () => {
      signals.forEach((s) => s.removeEventListener("abort", listener));
    },
  };
}

/**
 * Combine multiple callbacks into a single callback.
 * @param callback1 - The first callback to combine.
 * @param callback2 - The second callback to combine.
 * @returns A single callback that is a combination of the input callbacks.
 */
export const combineCallbacks = (
  callback1?: Callbacks,
  callback2?: Callbacks
): Callbacks | undefined => {
  if (!callback1 && !callback2) {
    return undefined;
  }

  if (!callback1) {
    return callback2;
  }

  if (!callback2) {
    return callback1;
  }
  if (Array.isArray(callback1) && Array.isArray(callback2)) {
    return [...callback1, ...callback2];
  }
  if (Array.isArray(callback1)) {
    return [...callback1, callback2] as Callbacks;
  }
  if (Array.isArray(callback2)) {
    return [callback1, ...callback2];
  }
  return [callback1, callback2] as Callbacks;
};
