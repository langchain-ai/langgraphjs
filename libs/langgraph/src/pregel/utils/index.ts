import { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { CONFIG_KEY_CHECKPOINT_MAP } from "../../constants.js";

export function getNullChannelVersion(currentVersions: ChannelVersions) {
  const versionValues = Object.values(currentVersions);
  const versionType =
    versionValues.length > 0 ? typeof versionValues[0] : undefined;
  let nullVersion: number | string | undefined;
  if (versionType === "number") {
    nullVersion = 0;
  } else if (versionType === "string") {
    nullVersion = "";
  }
  return nullVersion;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryOn?: (e: any) => boolean;

  /** Whether to log a warning when a retry is attempted. Defaults to true. */
  logWarning?: boolean;
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
 * @returns A single abort signal that is aborted if any of the input signals are aborted.
 */
export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0];
  }

  if ("any" in AbortSignal) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (AbortSignal as any).any(signals);
  }
  const combinedController = new AbortController();
  const listener = () => {
    combinedController.abort();
    signals.forEach((s) => s.removeEventListener("abort", listener));
  };

  signals.forEach((s) => s.addEventListener("abort", listener));

  if (signals.some((s) => s.aborted)) {
    combinedController.abort();
  }

  return combinedController.signal;
}
