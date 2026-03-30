/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ThreadState, BagTemplate } from "@langchain/langgraph-sdk";
import { Client, getClientConfigHash } from "@langchain/langgraph-sdk/client";
import type {
  UseStreamThread,
  ResolveStreamOptions,
  ResolveStreamInterface,
  InferBag,
} from "@langchain/langgraph-sdk/ui";
import { useStreamLGP } from "./stream.lgp.js";
import type { WithClassMessages } from "./stream.js";

// ---------------------------------------------------------------------------
// Suspense cache
// ---------------------------------------------------------------------------

export type SuspenseCacheEntry<T> =
  | { status: "pending"; promise: Promise<void> }
  | { status: "resolved"; data: T }
  | { status: "rejected"; error: unknown };

export type SuspenseCache = Map<string, SuspenseCacheEntry<unknown>>;

const defaultSuspenseCache: SuspenseCache = new Map();

export function createSuspenseCache(): SuspenseCache {
  return new Map();
}

function getCacheKey(
  client: Client,
  threadId: string,
  limit: boolean | number
): string {
  return `suspense:${getClientConfigHash(client)}:${threadId}:${limit}`;
}

function fetchThreadHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number }
): Promise<ThreadState<StateType>[]> {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }

  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

function getOrCreateCacheEntry<StateType extends Record<string, unknown>>(
  cache: SuspenseCache,
  client: Client,
  threadId: string,
  limit: boolean | number
): SuspenseCacheEntry<ThreadState<StateType>[]> {
  const key = getCacheKey(client, threadId, limit);
  let entry = cache.get(key) as
    | SuspenseCacheEntry<ThreadState<StateType>[]>
    | undefined;

  if (!entry) {
    // Start fetch. The promise always resolves (never rejects) so React
    // Suspense correctly waits for it and then retries the render.
    const promise = fetchThreadHistory<StateType>(client, threadId, { limit })
      .then((data) => {
        cache.set(key, { status: "resolved", data });
      })
      .catch((error: unknown) => {
        cache.set(key, { status: "rejected", error });
      });

    entry = { status: "pending", promise };
    cache.set(key, entry);
  }

  return entry;
}

/**
 * Clear the internal Suspense cache used by {@link useSuspenseStream}.
 *
 * Call this from an Error Boundary's `onReset` callback so that a retry
 * triggers a fresh thread-history fetch rather than re-throwing the
 * cached error.
 *
 * @example
 * ```tsx
 * <ErrorBoundary
 *   onReset={() => invalidateSuspenseCache()}
 *   fallbackRender={({ resetErrorBoundary }) => (
 *     <button onClick={resetErrorBoundary}>Retry</button>
 *   )}
 * >
 *   <Suspense fallback={<Spinner />}>
 *     <Chat />
 *   </Suspense>
 * </ErrorBoundary>
 * ```
 */
export function invalidateSuspenseCache(
  cache: SuspenseCache = defaultSuspenseCache
): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Return-type helper
// ---------------------------------------------------------------------------

type WithSuspense<T> = Omit<T, "isLoading" | "error" | "isThreadLoading"> & {
  isStreaming: boolean;
};

type UseSuspenseStreamOptions<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> = ResolveStreamOptions<T, InferBag<T, Bag>> & {
  /**
   * Optional cache store used by Suspense history prefetching.
   * Provide a custom cache in tests to avoid cross-test cache sharing.
   */
  suspenseCache?: SuspenseCache;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * A Suspense-compatible variant of {@link useStream} for LangGraph Platform.
 *
 * `useSuspenseStream` suspends the component while the initial thread
 * history is being fetched and throws errors to the nearest React Error
 * Boundary.  During active streaming the component stays rendered and
 * `isStreaming` indicates whether tokens are arriving.
 *
 * @example
 * ```tsx
 * <ErrorBoundary fallback={<ErrorDisplay />}>
 *   <Suspense fallback={<Spinner />}>
 *     <Chat />
 *   </Suspense>
 * </ErrorBoundary>
 *
 * function Chat() {
 *   const { messages, submit, isStreaming } = useSuspenseStream({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 *   return <MessageList messages={messages} />;
 * }
 * ```
 *
 * @template T - Either a ReactAgent / DeepAgent type or a state record type.
 * @template Bag - Type configuration bag (ConfigurableType, InterruptType, …).
 */
export function useSuspenseStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseSuspenseStreamOptions<T, InferBag<T, Bag>>
): WithClassMessages<WithSuspense<ResolveStreamInterface<T, InferBag<T, Bag>>>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useSuspenseStream(options: any): any {
  type StateType = Record<string, unknown>;
  const cache: SuspenseCache = options.suspenseCache ?? defaultSuspenseCache;

  // ---- client (needed before useStreamLGP for cache key derivation) ----
  const client = useMemo(
    () =>
      options.client ??
      new Client({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        callerOptions: options.callerOptions,
        defaultHeaders: options.defaultHeaders,
      }),
    [
      options.client,
      options.apiKey,
      options.apiUrl,
      options.callerOptions,
      options.defaultHeaders,
    ]
  );

  const { threadId } = options;

  const historyLimit: boolean | number =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? (options.fetchStateHistory.limit ?? false)
      : (options.fetchStateHistory ?? false);

  // Only manage history via the suspense cache when the caller hasn't
  // supplied an external `thread` and there's a threadId to load.
  const needsHistoryFetch = threadId != null && options.thread == null;

  // ---- suspense cache lookup (synchronous, may create fetch) ----
  let cacheEntry: SuspenseCacheEntry<ThreadState<StateType>[]> | undefined;

  if (needsHistoryFetch) {
    cacheEntry = getOrCreateCacheEntry<StateType>(
      cache,
      client,
      threadId,
      historyLimit
    );
  }

  const cachedData =
    cacheEntry?.status === "resolved" ? cacheEntry.data : undefined;

  // ---- mutable ref so `mutate` always writes the freshest data ----
  const cachedDataRef = useRef(cachedData);
  if (cachedData != null) {
    cachedDataRef.current = cachedData;
  }

  // Re-render trigger after external mutate calls.
  const [, setMutateVersion] = useState(0);

  const mutate = useCallback(
    async (
      mutateId?: string
    ): Promise<ThreadState<StateType>[] | null | undefined> => {
      const fetchId = mutateId ?? threadId;
      if (!fetchId) return undefined;
      try {
        const data = await fetchThreadHistory<StateType>(client, fetchId, {
          limit: historyLimit,
        });
        const key = getCacheKey(client, fetchId, historyLimit);
        cache.set(key, { status: "resolved", data });
        cachedDataRef.current = data;
        setMutateVersion((v) => v + 1);
        return data;
      } catch {
        return undefined;
      }
    },
    [cache, client, threadId, historyLimit]
  );

  // ---- build thread override for useStreamLGP ----
  const thread: UseStreamThread<StateType> | undefined = useMemo(() => {
    if (!needsHistoryFetch) return options.thread;
    return {
      data: cachedDataRef.current,
      error: undefined,
      isLoading: false,
      mutate,
    };
    // `cachedData` is included so the memo recomputes when the cache
    // transitions from pending → resolved across suspend/retry cycles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsHistoryFetch, options.thread, cachedData, mutate]);

  // ---- delegate to useStreamLGP (must always run – Rules of Hooks) ----
  const stream = useStreamLGP({
    ...options,
    client,
    thread,
  });

  // ---- post-hook: suspend or throw ----

  // Suspend while thread history is loading, but only when the stream
  // itself is idle. If an active stream is running (e.g. the thread was
  // just created during submit), suspending would discard the stream
  // state, so we skip it.
  if (needsHistoryFetch && cacheEntry && !stream.isLoading) {
    if (cacheEntry.status === "pending") {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw cacheEntry.promise;
    }
    if (cacheEntry.status === "rejected") {
      // Clear cache so a subsequent retry (ErrorBoundary reset) starts
      // a fresh fetch instead of re-throwing the stale error.
      const key = getCacheKey(client, threadId!, historyLimit);
      cache.delete(key);
      // eslint-disable-next-line no-instanceof/no-instanceof
      throw cacheEntry.error instanceof Error
        ? cacheEntry.error
        : new Error(String(cacheEntry.error));
    }
  }

  // Throw non-streaming errors to the nearest Error Boundary.
  if (stream.error != null && !stream.isLoading) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw stream.error instanceof Error
      ? stream.error
      : new Error(String(stream.error));
  }

  // Build return object explicitly to avoid triggering throwing getters
  // (e.g. `history` throws when `fetchStateHistory` is not set).
  return {
    get values() {
      return stream.values;
    },
    get messages() {
      return stream.messages;
    },
    get toolCalls() {
      return stream.toolCalls;
    },
    get toolProgress() {
      return stream.toolProgress;
    },
    getToolCalls: stream.getToolCalls.bind(stream),
    get interrupt() {
      return stream.interrupt;
    },
    get interrupts() {
      return stream.interrupts;
    },
    get subagents() {
      return stream.subagents;
    },
    get activeSubagents() {
      return stream.activeSubagents;
    },
    getSubagent: stream.getSubagent.bind(stream),
    getSubagentsByType: stream.getSubagentsByType.bind(stream),
    getSubagentsByMessage: stream.getSubagentsByMessage.bind(stream),
    getMessagesMetadata: stream.getMessagesMetadata.bind(stream),
    get history() {
      return stream.history;
    },
    get experimental_branchTree() {
      return stream.experimental_branchTree;
    },
    stop: stream.stop,
    submit: stream.submit,
    switchThread: stream.switchThread,
    joinStream: stream.joinStream,
    get branch() {
      return stream.branch;
    },
    setBranch: stream.setBranch,
    get client() {
      return stream.client;
    },
    get assistantId() {
      return stream.assistantId;
    },
    get queue() {
      return stream.queue;
    },
    get isStreaming() {
      return stream.isLoading;
    },
  };
}
