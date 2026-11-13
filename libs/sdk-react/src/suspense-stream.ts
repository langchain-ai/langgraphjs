/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import type { InferStateType } from "@langchain/langgraph-sdk/ui";
import {
  suspendedBindings,
  useStreamBinding,
  type AnyStream,
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

/** Any {@link useSuspenseStream} result, its state widened as {@link AnyStream}'s is. */
export type AnySuspenseStream = Omit<
  AnyStream,
  "isLoading" | "isThreadLoading" | "hydrationPromise"
> & {
  readonly isStreaming: boolean;
};

/**
 * {@link useStream} for Suspense: suspends while the thread loads, and
 * throws a failed load to the nearest error boundary. A run's error stays in
 * `error`, so the conversation stays on screen.
 *
 * A server render reads nothing: the hook throws an error with the `digest`
 * `"BAILOUT_TO_CLIENT_SIDE_RENDERING"`, so React renders the Suspense
 * fallback on the server and the hook in the browser. Next.js doesn't report
 * that error. Elsewhere, skip it by its `digest` in the server's `onError`
 * and the browser's `onRecoverableError`.
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
    // The server snapshot reads nothing, so there's no load to wait for:
    // React renders the fallback instead, and this hook in the browser.
    if (stream === binding.getServerSnapshot()) {
      throw Object.assign(
        new Error(
          "@langchain/react: useSuspenseStream reads its thread in the browser, so the server renders the Suspense fallback."
        ),
        // Next.js's mark for rendering on the client, which it doesn't log.
        { digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" }
      );
    }
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
