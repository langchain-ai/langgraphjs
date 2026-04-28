import { inject } from "@angular/core";
import type { InferStateType } from "@langchain/langgraph-sdk/stream";
import {
  STREAM_DEFAULTS,
  STREAM_INSTANCE,
  type StreamDefaults,
} from "./context.js";
import {
  useStream,
  type StreamApi,
  type UseStreamOptions,
} from "./use-stream.js";

/**
 * Angular entry point for the v2-native stream runtime.
 *
 * Call from a component, directive, or service field initializer to
 * attach an {@link StreamApi} bound to the current {@link DestroyRef}:
 *
 * ```ts
 * @Component({ template: `<div>{{ stream.messages() | json }}</div>` })
 * export class Chat {
 *   readonly stream = injectStream({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 * }
 * ```
 *
 * When called with no arguments, looks up a shared `StreamApi`
 * previously registered via {@link provideStream}. Throws if no
 * ancestor provider exists.
 *
 * Must always run inside an Angular injection context.
 */
export function injectStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(): StreamApi<T, InterruptType, ConfigurableType>;
export function injectStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>
): StreamApi<T, InterruptType, ConfigurableType>;
export function injectStream(
  options?: UseStreamOptions<Record<string, unknown>>
): StreamApi {
  if (options == null) {
    const shared = inject(STREAM_INSTANCE, { optional: true });
    if (shared == null) {
      throw new Error(
        "injectStream() requires an ancestor to call provideStream(). " +
          "Add provideStream({ assistantId: '...' }) to a parent component's " +
          "providers array, or call injectStream(options) directly."
      );
    }
    return shared as StreamApi;
  }

  const defaults = inject(STREAM_DEFAULTS, { optional: true }) ?? undefined;
  const merged = mergeDefaults(options, defaults);
  return useStream(merged) as StreamApi;
}

function mergeDefaults<S extends object>(
  options: UseStreamOptions<S>,
  defaults: StreamDefaults | undefined
): UseStreamOptions<S> {
  if (defaults == null) return options;
  // Only merge into the agent-server branch — the custom-adapter
  // branch owns its own wire and must not inherit `apiUrl` / `client`.
  if (
    (options as { transport?: unknown }).transport != null &&
    typeof (options as { transport: unknown }).transport !== "string"
  ) {
    return options;
  }
  const bag = options as unknown as Record<string, unknown>;
  return {
    ...bag,
    apiUrl: bag.apiUrl ?? defaults.apiUrl,
    apiKey: bag.apiKey ?? defaults.apiKey,
    client: bag.client ?? defaults.client,
  } as unknown as UseStreamOptions<S>;
}
