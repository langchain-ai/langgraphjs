import { Callbacks } from "@langchain/core/callbacks/manager";
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

function isMultiAbortSignal(signal: unknown): signal is MultiAbortSignal {
  return (
    typeof signal === "object" &&
    signal !== null &&
    "_dependentSignals" in signal &&
    "getDependentSignals" in signal &&
    typeof signal.getDependentSignals === "function"
  );
}

/**
 * MultiAbortSignal combines multiple AbortSignal instances into a single signal that aborts
 * when any of the provided signals aborts. Instead of generically creating new signals,
 * this deduplicates signals and avoids redundant event listeners by flattening nested
 * MultiAbortSignal dependencies.
 *
 * This takes on a similar shape to node's native implementation of `AbortSignal.any()`, but
 * is inlined here since the native implementation suffers from memory leaks in older versions of node.
 * @see https://github.com/nodejs/node/issues/55328
 */
export class MultiAbortSignal extends EventTarget implements AbortSignal {
  /** @internal */
  private _controller: AbortController;

  /** @internal */
  private _signal: AbortSignal;

  /** @internal */
  private _reason: unknown;

  /**
   * The set of signals that are directly tracked by this MultiAbortSignal.
   * @internal
   */
  private _dependentSignals = new Set<AbortSignal>();

  /**
   * Creates a new MultiAbortSignal that aborts when any of the provided signals aborts.
   * This signal manages listeners on the direct input signals, avoiding
   * redundant listeners for signals already implicitly covered by other MultiAbortSignals.
   * @param {Iterable<AbortSignal>} signals - An iterable of AbortSignal objects.
   */
  constructor(...signals: AbortSignal[]) {
    super();

    this._controller = new AbortController();
    this._signal = this._controller.signal;

    // First, we resolve all downstream signals that are contained
    // in the hierarchy of the signals passed into the constructor.
    const knownSignals: AbortSignal[] = [];
    for (const signal of signals) {
      if (isMultiAbortSignal(signal)) {
        knownSignals.push(...signal.getDependentSignals());
      }
    }
    // Then, we enumerate the signals to dedupe them.
    for (const signal of signals) {
      // If the signal passed into the constructor is already tracked
      // in a downstream MultiAbortSignal, we skip it.
      if (knownSignals.includes(signal)) continue;
      // Otherwise, we add it to the list of signals that need event listeners.
      this._dependentSignals.add(signal);
    }

    const _abortWithReason = (reason: unknown) => {
      this._controller.abort(reason);
      this._reason = reason;
      this.dispatchEvent(new Event("abort"));
    };
    const abortListener = (event: Event) => {
      const target = event.target as AbortSignal;
      _abortWithReason(target.reason);
      // Clean up event listeners from all signals we planned to watch
      for (const signal of this._dependentSignals) {
        signal.removeEventListener("abort", abortListener);
      }
    };

    for (const signal of this._dependentSignals) {
      if (signal.aborted) {
        // If any signal is already aborted, immediately abort the combined signal
        _abortWithReason(signal.reason);
        for (const signal of this._dependentSignals) {
          signal.removeEventListener("abort", abortListener);
        }
        return;
      }
      // Attach listener with a signal for automatic cleanup
      signal.addEventListener("abort", abortListener, { signal: this._signal });
    }
  }

  get aborted(): boolean {
    return this._signal.aborted;
  }

  get reason(): unknown {
    return this._reason;
  }

  throwIfAborted(): void {
    this._signal.throwIfAborted();
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (listener === null) return;

    if (type === "abort") {
      super.addEventListener(type, listener, options);
    } else {
      this._signal.addEventListener(type, listener, options);
    }
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    if (listener === null) return;

    if (type === "abort") {
      super.removeEventListener(type, listener, options);
    } else {
      this._signal.removeEventListener(type, listener, options);
    }
  }

  set onabort(value: ((this: AbortSignal, ev: Event) => void) | null) {
    this._signal.onabort = value;
  }

  get onabort(): ((this: AbortSignal, ev: Event) => void) | null {
    return this._signal.onabort;
  }

  /**
   * Returns a flattened set of signals that are contained within the hierarchy of a MultiAbortSignal.
   * If a MultiAbortSignal was passed as a signal into the constructor, it's dependent signals will be
   * included in the returned set.
   */
  getDependentSignals(): ReadonlySet<AbortSignal> {
    const out: AbortSignal[] = [];
    for (const signal of this._dependentSignals) {
      out.push(signal);
      if (isMultiAbortSignal(signal)) {
        out.push(...signal.getDependentSignals());
      }
    }
    return new Set(out);
  }
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
