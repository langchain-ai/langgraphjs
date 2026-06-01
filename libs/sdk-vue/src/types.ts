import type { MaybeRefOrGetter } from "vue";

/**
 * Option keys that support Vue reactive values via MaybeRefOrGetter.
 */
type ReactiveOptionKeys =
  | "assistantId"
  | "apiUrl"
  | "apiKey"
  | "callerOptions"
  | "defaultHeaders"
  | "client"
  | "threadId"
  | "messagesKey";

/**
 * Wraps specific option keys to accept MaybeRefOrGetter for Vue reactivity.
 * Allows options like assistantId, apiUrl, threadId, etc. to be passed as
 * plain values, Vue refs, or getter functions.
 *
 * @example
 * ```typescript
 * const assistantId = ref("agent");
 * const apiUrl = computed(() => getApiUrl());
 *
 * useStream({
 *   assistantId,        // Ref<string>
 *   apiUrl,             // ComputedRef<string>
 *   threadId: null,     // plain value (still works)
 * });
 * ```
 */
export type VueReactiveOptions<T> = {
  [K in keyof T]: K extends ReactiveOptionKeys ? MaybeRefOrGetter<T[K]> : T[K];
};
