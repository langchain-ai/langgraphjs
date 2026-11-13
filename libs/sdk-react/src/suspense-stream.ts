/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import type { InferStateType } from "@langchain/langgraph-sdk/ui";
import {
  suspendedBindings,
  useStreamBinding,
  type UseStreamReturn,
} from "./use-stream.js";
import type { UseStreamOptions } from "./types.js";

/**
 * What {@link useSuspenseStream} returns: the stream without its loading
 * flags, since Suspense shows the load, plus {@link isStreaming}.
 */
export type UseSuspenseStreamReturn<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = Omit<
  UseStreamReturn<T, InterruptType, ConfigurableType>,
  "isLoading" | "isThreadLoading" | "hydrationPromise"
> & {
  /** Whether a run is streaming. */
  isStreaming: boolean;
};

/**
 * {@link useStream} for Suspense: suspends while the thread loads, and
 * throws a failed load to the nearest error boundary. A run's error stays in
 * `error`, so the conversation stays on screen.
 *
 * ```tsx
 * <ErrorBoundary fallback={<ErrorDisplay />}>
 *   <Suspense fallback={<Spinner />}>
 *     <Chat />
 *   </Suspense>
 * </ErrorBoundary>
 * ```
 */
export function useSuspenseStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>
): UseSuspenseStreamReturn<T, InterruptType, ConfigurableType> {
  const key =
    options.threadId == null
      ? undefined
      : JSON.stringify([options.apiUrl, options.assistantId, options.threadId]);
  const { binding, stream } = useStreamBinding(
    options as UseStreamOptions,
    key
  );
  if (stream.isThreadLoading) {
    if (key != null && !binding.committed) {
      suspendedBindings.set(key, binding);
      // A render that never retries, its tree unmounted, leaves the binding:
      // stale for a later mount, and an engine that never activates.
      void stream.hydrationPromise.then(() =>
        setTimeout(() => {
          if (suspendedBindings.get(key) === binding) {
            suspendedBindings.delete(key);
            binding.engine.dispose();
          }
        }, 1_000)
      );
    }
    throw stream.hydrationPromise;
  }
  const loadError = binding.engine.historyData.error;
  if (loadError != null) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw loadError instanceof Error ? loadError : new Error(String(loadError));
  }
  const {
    isLoading,
    isThreadLoading: _isThreadLoading,
    hydrationPromise: _hydrationPromise,
    ...rest
  } = stream;
  return {
    ...rest,
    isStreaming: isLoading,
  } as unknown as UseSuspenseStreamReturn<T, InterruptType, ConfigurableType>;
}
