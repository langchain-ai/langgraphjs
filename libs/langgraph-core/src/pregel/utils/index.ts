import { Callbacks } from "@langchain/core/callbacks/manager";
import { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import {
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_CHECKPOINT_MAP,
  START,
  WAITING_EDGE_CHANNEL_PREFIX,
} from "../../constants.js";

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

  /**
   * Whether to add random jitter to the interval between retries.
   * @default true
   */
  jitter?: boolean;

  /** A function that returns True for exceptions that should trigger a retry. */
  retryOn?: (e: any) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Whether to log a warning when a retry is attempted. Defaults to true. */
  logWarning?: boolean;
};

export type { TimeoutPolicy } from "./timeout.js";
export { coerceTimeoutPolicy } from "./timeout.js";

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
  const signals = [...new Set(x.filter(Boolean))] as AbortSignal[];

  if (signals.length === 0) {
    return { signal: undefined, dispose: undefined };
  }

  if (signals.length === 1) {
    return { signal: signals[0], dispose: undefined };
  }

  const combinedController = new AbortController();
  const listener = () => {
    const reason = signals.find((s) => s.aborted)?.reason;
    combinedController.abort(reason);
    signals.forEach((s) => s.removeEventListener("abort", listener));
  };

  signals.forEach((s) => s.addEventListener("abort", listener, { once: true }));

  const hasAlreadyAbortedSignal = signals.find((s) => s.aborted);
  if (hasAlreadyAbortedSignal) {
    combinedController.abort(hasAlreadyAbortedSignal.reason);
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

function isNodeNameSet(value: unknown): value is Set<string> {
  const candidate = value as Set<string> | undefined;
  return (
    typeof candidate?.has === "function" && typeof candidate?.size === "number"
  );
}

/** Is this channel the one backing a waiting edge? */
function isWaitingEdgeChannel(name: string): boolean {
  return name.startsWith(WAITING_EDGE_CHANNEL_PREFIX);
}

/**
 * The node a waiting edge feeds, read from its channel name.
 *
 * Splitting on the last colon is safe because `StateGraph.addNode` rejects node
 * names containing {@link CHECKPOINT_NAMESPACE_END}.
 */
function waitingEdgeTarget(channelName: string): string {
  return channelName.slice(
    channelName.lastIndexOf(CHECKPOINT_NAMESPACE_END) + 1
  );
}

/**
 * The nodes a waiting edge lists, read from its channel name.
 *
 * `addEdge` builds the name as `join:<starts joined by +>:<end>`, so the set is
 * recoverable without the channel definitions. The join character is **not**
 * reserved in node names, so the split is ambiguous for a node named `a+b`;
 * callers check the result against what the barrier has seen and drop it when the
 * two disagree.
 */
function waitingEdgeStarts(channelName: string): string[] | undefined {
  const body = channelName.slice(
    WAITING_EDGE_CHANNEL_PREFIX.length,
    channelName.lastIndexOf(CHECKPOINT_NAMESPACE_END)
  );
  return body === "" ? undefined : body.split("+");
}

// Both collectors return `WaitingEdgeDescription`'s shape without naming it:
// `../types.js` already imports this module, so importing it back is a cycle.

/**
 * Collect the waiting edges — `addEdge([...], target)` — that have received
 * some of their listed nodes but not all, so `target` has not run.
 *
 * The barrier channel clears `seen` when it releases, so a partially filled
 * `seen` means the edge received writes and has not released.
 *
 * @param channels - Live channels, e.g. from `channelsFromCheckpoint`.
 */
export function collectWaitingEdges(
  channels: Record<string, unknown>
): { target: string; completed: string[]; missing: string[] }[] {
  const waiting: { target: string; completed: string[]; missing: string[] }[] =
    [];
  for (const [name, channel] of Object.entries(channels)) {
    if (!isWaitingEdgeChannel(name)) continue;
    const { names, seen, released } = (channel ?? {}) as {
      names?: unknown;
      seen?: unknown;
      released?: unknown;
    };
    // Narrows both from `unknown`; no channel carrying this prefix is anything
    // other than a barrier, so this is a type guard rather than a runtime one.
    if (!isNodeNameSet(names) || !isNodeNameSet(seen)) continue;
    // An inclusive barrier that released at quiescence is not stalled: its
    // target is a scheduled task, and consume() will clear it.
    if (released === true) continue;
    // An empty `seen` means the edge released; a full one means it is waiting for
    // its target rather than for a write, which is not a dropped write.
    if (seen.size === 0 || seen.size >= names.size) continue;
    waiting.push({
      target: waitingEdgeTarget(name),
      completed: [...seen],
      missing: [...names].filter((node) => !seen.has(node)),
    });
  }
  return waiting;
}

/**
 * Collect unreleased waiting edges from a checkpoint's stored channel values,
 * without the channel definitions.
 *
 * A barrier stores only the names it has seen, and `consume()` clears them when
 * the edge releases — so a stored non-empty list means the edge received writes
 * and never released, and no expected-name set is needed to detect it. The listed nodes
 * come from the channel name, which encodes them — so `missing` is available
 * here too, except for a name this cannot parse unambiguously.
 *
 * @param values - `checkpoint.channel_values`.
 * @param namespace - Recorded on each entry so the caller can tell whose it is.
 */
export function collectWaitingEdgesFromValues(
  values: Record<string, unknown>,
  namespace: string
): {
  target: string;
  completed: string[];
  missing?: string[];
  namespace: string;
  path: string[];
}[] {
  const waiting: {
    target: string;
    completed: string[];
    missing?: string[];
    namespace: string;
    path: string[];
  }[] = [];
  // A namespace is `node:taskId` per level, joined by the separator; the task
  // ids are per-invocation, so the node names are the stable part.
  const path = namespace
    .split(CHECKPOINT_NAMESPACE_SEPARATOR)
    .map((segment) => segment.split(CHECKPOINT_NAMESPACE_END)[0])
    .filter((segment) => segment !== "");
  for (const [name, value] of Object.entries(values)) {
    if (!isWaitingEdgeChannel(name)) continue;
    // `NamedBarrierValue` stores `seen`; the `defer` variant stores
    // `[seen, finished]`.
    const seen =
      Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
    if (!Array.isArray(seen) || seen.length === 0) continue;
    if (!seen.every((entry): entry is string => typeof entry === "string")) {
      continue;
    }
    // The listed nodes come from the channel name, which encodes them. A parse
    // the barrier's own contents contradict is one this cannot read — a node
    // named with the join character, or a state key that merely looks like a
    // barrier — and it yields no set rather than a wrong one.
    const parsed = waitingEdgeStarts(name);
    const starts =
      parsed !== undefined && seen.every((node) => parsed.includes(node))
        ? parsed
        : undefined;
    // Every listed node has written, so the edge is waiting for its target to
    // run rather than for a write: nothing was dropped. The same guard as the
    // definitions-based collector, which reads the count off `names`.
    if (starts !== undefined && seen.length >= starts.length) continue;
    const missing = starts?.filter((start) => !seen.includes(start));
    waiting.push({
      target: waitingEdgeTarget(name),
      completed: [...seen],
      ...(missing ? { missing } : {}),
      namespace,
      path,
    });
  }
  return waiting;
}
