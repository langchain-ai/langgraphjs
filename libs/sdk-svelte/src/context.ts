import { getContext, setContext } from "svelte";
import type { InferStateType } from "@langchain/langgraph-sdk/stream";
import {
  useStream,
  type AgentServerOptions,
  type CustomAdapterOptions,
  type UseStreamOptions,
  type UseStreamReturn,
} from "./use-stream.svelte.js";

/**
 * Context key used for the shared stream handle exposed via
 * {@link provideStream}. Exported so advanced callers can drive
 * Svelte's context API directly (e.g. a shared context in a
 * microfrontend shell).
 */
export const STREAM_CONTEXT_KEY: unique symbol = Symbol.for(
  "@langchain/svelte/stream-context"
);

/**
 * Props for {@link provideStream} when talking to the default
 * LangGraph-Platform agent server.
 */
export type ProvideStreamProps<T = Record<string, unknown>> =
  AgentServerOptions<InferStateType<T>>;

/**
 * Props for {@link provideStream} when wiring a custom
 * {@link AgentServerAdapter}.
 */
export type ProvideStreamCustomProps<T = Record<string, unknown>> =
  CustomAdapterOptions<InferStateType<T>>;

/**
 * Creates a shared {@link useStream} handle and publishes it via
 * Svelte's `setContext`. Descendant components read it via
 * {@link getStream}.
 *
 * Must be called during component initialisation (the top level of a
 * `<script>` block or `<script module>` that runs at mount), same
 * lifecycle constraint as `setContext`.
 *
 * @example
 * ```svelte
 * <!-- ChatContainer.svelte -->
 * <script lang="ts">
 *   import { provideStream } from "@langchain/svelte";
 *
 *   provideStream({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 * </script>
 *
 * <ChatHeader />
 * <MessageList />
 * <MessageInput />
 * ```
 */
export function provideStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: ProvideStreamProps<T> | ProvideStreamCustomProps<T>
): UseStreamReturn<T, InterruptType, ConfigurableType> {
  const stream = useStream<T, InterruptType, ConfigurableType>(
    options as UseStreamOptions<InferStateType<T>>
  );
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * Reads the shared stream handle exposed by the nearest ancestor
 * {@link provideStream} call. Throws when no ancestor has provided
 * one.
 *
 * @example
 * ```svelte
 * <!-- MessageList.svelte -->
 * <script lang="ts">
 *   import { getStream } from "@langchain/svelte";
 *   import type { agent } from "./agent";
 *
 *   const stream = getStream<typeof agent>();
 * </script>
 *
 * {#each stream.messages as msg (msg.id)}
 *   <div>{msg.content}</div>
 * {/each}
 * ```
 */
export function getStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(): UseStreamReturn<T, InterruptType, ConfigurableType> {
  const context = getContext<
    UseStreamReturn<T, InterruptType, ConfigurableType> | undefined
  >(STREAM_CONTEXT_KEY);
  if (context == null) {
    throw new Error(
      "getStream() requires a parent component to call provideStream(). " +
        "Add provideStream({ assistantId: '...' }) in an ancestor component."
    );
  }
  return context;
}

// ─── Deprecated aliases ───────────────────────────────────────────────
//
// Retained for one minor release so v0 call sites keep resolving.
// Emit a dev-mode `console.warn` on first call per session.

const warnedAliases = new Set<string>();
function warnOnce(name: string, replacement: string) {
  if (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV === "production"
  ) {
    return;
  }
  if (warnedAliases.has(name)) return;
  warnedAliases.add(name);
  // eslint-disable-next-line no-console
  console.warn(
    `[@langchain/svelte] ${name}() is deprecated and will be removed in a future major release. ` +
      `Use ${replacement}() instead.`
  );
}

/**
 * @deprecated Use {@link provideStream} instead. This alias will be
 * removed in a future major release.
 */
export function setStreamContext<
  T extends UseStreamReturn<unknown, unknown, object>,
>(stream: T): T {
  warnOnce("setStreamContext", "provideStream");
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * @deprecated Use {@link getStream} instead. This alias will be
 * removed in a future major release.
 */
export function getStreamContext<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(): UseStreamReturn<T, InterruptType, ConfigurableType> {
  warnOnce("getStreamContext", "getStream");
  return getStream<T, InterruptType, ConfigurableType>();
}
