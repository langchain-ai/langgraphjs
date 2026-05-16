/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

/**
 * Slim v1 port of `useSuspenseStream`.
 *
 * Rebuilt on top of the v2-native {@link useStream} hook. The legacy
 * implementation (pre-v1) prefetched `threads.getHistory(threadId)`
 * into an external `SuspenseCache` because the legacy hook had no
 * hydration affordance. v1 drops the `history` surface entirely and
 * exposes {@link StreamController.hydrationPromise} directly, so the
 * suspense integration reduces to:
 *
 *   1. Suspend (throw the hydration promise) while the first hydrate
 *      call for the current thread is in flight.
 *   2. Throw non-streaming errors to the nearest Error Boundary.
 *   3. Rename `isLoading` → `isStreaming` so the caller can model a
 *      rendered-but-streaming state distinct from the suspended
 *      initial-load state.
 *
 * Dropped from the pre-v1 surface (replaced by the built-in hydrate
 * lifecycle or no longer applicable once `history` is gone):
 *
 * - `SuspenseCache`, `createSuspenseCache`, `invalidateSuspenseCache`
 * - the `suspenseCache` option
 * - the `fetchStateHistory: { limit }` prefetch knob
 */

import type { Interrupt } from "@langchain/langgraph-sdk";
import type {
  AssembledToolCall,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
  InferStateType,
} from "@langchain/langgraph-sdk/stream";
import {
  useStream,
  type UseStreamOptions,
  type UseStreamReturn,
} from "./use-stream.js";

/**
 * Return shape of {@link useSuspenseStream}. Identical to the
 * {@link UseStreamReturn} surface except:
 *
 * - `isLoading` / `isThreadLoading` / `hydrationPromise` are removed
 *   (Suspense and Error Boundaries handle those phases).
 * - `isStreaming: boolean` is added so callers can show a streaming
 *   indicator distinct from the suspended initial-load state.
 */
export type UseSuspenseStreamReturn<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = Omit<
  UseStreamReturn<T, InterruptType, ConfigurableType>,
  "isLoading" | "isThreadLoading" | "hydrationPromise"
> & {
  /**
   * Whether the stream is currently receiving data from the server.
   * Unlike the suspended initial-load state, the component stays
   * mounted while `isStreaming` is `true`.
   */
  isStreaming: boolean;
};

/**
 * Suspense-compatible variant of {@link useStream}.
 *
 * Suspends the component while the initial thread hydration is in
 * flight and throws non-streaming errors to the nearest Error
 * Boundary. During active streaming the component stays rendered and
 * {@link UseSuspenseStreamReturn.isStreaming} indicates whether
 * tokens are arriving.
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
 *     threadId,
 *   });
 *   return <MessageList messages={messages} streaming={isStreaming} />;
 * }
 * ```
 */
/**
 * Module-level cache of in-flight / settled hydration attempts keyed
 * on a stable `(apiUrl, assistantId, threadId)` tuple. Required
 * because React Suspense discards the suspended fiber while the
 * thrown promise is unresolved, so the `StreamController` (and its
 * `hydrationPromise`) created in one render is thrown away before
 * the next render runs. Without this external store we'd spawn a
 * fresh controller on every retry and never converge.
 *
 * The cache stores the settled outcome (success/failure) so
 * re-renders after commit short-circuit without waiting. Entries are
 * keyed loosely — two mounts of the same `(apiUrl, assistantId,
 * threadId)` tuple share a single hydration.
 */
interface SuspenseEntry {
  promise: Promise<void>;
  settled: boolean;
  error?: Error;
}
const suspenseEntries = new Map<string, SuspenseEntry>();

function suspenseKey(options: {
  apiUrl?: string;
  assistantId?: string;
  threadId?: string | null;
}): string | null {
  if (options.threadId == null) return null;
  return `${options.apiUrl ?? "_"}::${options.assistantId ?? "_"}::${options.threadId}`;
}

export function useSuspenseStream<T = Record<string, unknown>>(
  options: UseStreamOptions<InferStateType<T>>
): UseSuspenseStreamReturn<T> {
  const asBag = options as {
    apiUrl?: string;
    assistantId?: string;
    threadId?: string | null;
  };
  const key = suspenseKey(asBag);

  const stream = useStream<T>(options as Parameters<typeof useStream<T>>[0]);

  // First render for this `(apiUrl, assistantId, threadId)`: install
  // an entry that tracks the current controller's hydration. The
  // same promise is thrown on every retry, so React Suspense sees a
  // stable dependency even when the fiber — and its controller — is
  // discarded and rebuilt between retries.
  if (key != null && !suspenseEntries.has(key)) {
    const entry: SuspenseEntry = {
      promise: stream.hydrationPromise.then(
        () => {
          entry.settled = true;
        },
        (error) => {
          entry.settled = true;
          entry.error =
            // eslint-disable-next-line no-instanceof/no-instanceof
            error instanceof Error ? error : new Error(String(error));
          throw entry.error;
        }
      ),
      settled: false,
    };
    suspenseEntries.set(key, entry);
  }

  const entry = key != null ? suspenseEntries.get(key) : undefined;

  // Suspend until the first hydrate settles. The promise is stable
  // across Suspense retries because it's anchored in the module-
  // level cache, not in the per-render controller.
  if (entry && !entry.settled) {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw entry.promise;
  }

  // Propagate hydrate failures to the nearest Error Boundary once.
  if (entry?.error != null) {
    throw entry.error;
  }

  // Hydration errors surface via `stream.error` after the promise
  // rejects; hand them to the nearest Error Boundary when no run is
  // currently active (streaming errors must stay in-hook so the UI
  // can recover without losing partial content).
  if (stream.error != null && !stream.isLoading) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw stream.error instanceof Error
      ? stream.error
      : new Error(String(stream.error));
  }

  // Build the return object with explicit getters so lazy access
  // still reflects the latest snapshot even if the caller destructures
  // late in a render.
  return {
    get values() {
      return stream.values as UseSuspenseStreamReturn<T>["values"];
    },
    get messages() {
      return stream.messages;
    },
    get toolCalls(): AssembledToolCall[] {
      return stream.toolCalls;
    },
    get interrupt(): Interrupt | undefined {
      return stream.interrupt as Interrupt | undefined;
    },
    get interrupts(): Interrupt[] {
      return stream.interrupts as Interrupt[];
    },
    get subagents() {
      return stream.subagents as ReadonlyMap<
        string,
        SubagentDiscoverySnapshot
      > as UseSuspenseStreamReturn<T>["subagents"];
    },
    get subgraphs(): ReadonlyMap<string, SubgraphDiscoverySnapshot> {
      return stream.subgraphs;
    },
    get subgraphsByNode(): ReadonlyMap<
      string,
      readonly SubgraphDiscoverySnapshot[]
    > {
      return stream.subgraphsByNode;
    },
    submit: stream.submit as UseSuspenseStreamReturn<T>["submit"],
    stop: stream.stop,
    respond: stream.respond as UseSuspenseStreamReturn<T>["respond"],
    getThread: stream.getThread,
    get client() {
      return stream.client;
    },
    get assistantId() {
      return stream.assistantId;
    },
    get threadId() {
      return stream.threadId;
    },
    get error() {
      return stream.error;
    },
    get isStreaming() {
      return stream.isLoading;
    },
  } as UseSuspenseStreamReturn<T>;
}

// Re-export the transitional companion types so existing call sites
// keep resolving without reaching into `./use-stream.js` directly.
export type { SubmissionQueueEntry, SubmissionQueueSnapshot };
