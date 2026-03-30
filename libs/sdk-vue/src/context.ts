import { provide, inject, type InjectionKey, type App, type Plugin } from "vue";
import type { BagTemplate } from "@langchain/langgraph-sdk";
import type {
  ResolveStreamOptions,
  InferBag,
  InferStateType,
  UseStreamCustomOptions,
} from "@langchain/langgraph-sdk/ui";
import { Client } from "@langchain/langgraph-sdk";
import { useStream } from "./index.js";

/**
 * Configuration options for the LangChain Vue plugin.
 * These provide default values that `useStream` will pick up automatically.
 */
export interface LangChainPluginOptions {
  /** Base URL of the LangGraph API. */
  apiUrl?: string;
  /** API key for authenticating with the LangGraph API. */
  apiKey?: string;
  /** Pre-configured Client instance. */
  client?: Client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STREAM_CONTEXT_KEY: InjectionKey<any> = Symbol("langchain-stream");

export const LANGCHAIN_OPTIONS: InjectionKey<LangChainPluginOptions> =
  Symbol("langchain-options");

/**
 * Vue plugin that provides default LangGraph configuration to all components.
 *
 * When installed, `useStream` composables throughout the application will
 * automatically use the configured `apiUrl` and `client` without requiring
 * explicit options.
 *
 * @example
 * ```typescript
 * import { createApp } from "vue";
 * import { LangChainPlugin } from "@langchain/vue";
 * import App from "./App.vue";
 *
 * const app = createApp(App);
 * app.use(LangChainPlugin, {
 *   apiUrl: "http://localhost:2024",
 * });
 * app.mount("#app");
 * ```
 *
 * Then in any component:
 * ```vue
 * <script setup lang="ts">
 * import { useStream } from "@langchain/vue";
 *
 * // apiUrl is inherited from the plugin — no need to repeat it
 * const stream = useStream({ assistantId: "agent" });
 * </script>
 * ```
 */
export const LangChainPlugin: Plugin<[LangChainPluginOptions?]> = {
  install(app: App, options: LangChainPluginOptions = {}) {
    app.provide(LANGCHAIN_OPTIONS, options);
  },
};

/**
 * Creates a shared `useStream` instance and provides it to all descendant
 * components via Vue's `provide`/`inject`.
 *
 * Call this in a parent component's `<script setup>` to make the stream
 * available to children via `useStreamContext()`.
 *
 * @example
 * ```vue
 * <!-- ChatContainer.vue -->
 * <script setup lang="ts">
 * import { provideStream } from "@langchain/vue";
 *
 * provideStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
 * </script>
 *
 * <template>
 *   <ChatHeader />
 *   <MessageList />
 *   <MessageInput />
 * </template>
 * ```
 *
 * @returns The stream instance (same as calling `useStream` directly).
 */
export function provideStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options:
    | ResolveStreamOptions<T, InferBag<T, Bag>>
    | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): ReturnType<typeof useStream<T, Bag>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = useStream<T, Bag>(options as any);
  provide(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * Accesses the shared stream instance from the nearest ancestor that
 * called `provideStream()`.
 *
 * Throws if no ancestor has provided a stream.
 *
 * @example
 * ```vue
 * <!-- MessageList.vue -->
 * <script setup lang="ts">
 * import { useStreamContext } from "@langchain/vue";
 *
 * const { messages } = useStreamContext();
 * </script>
 *
 * <template>
 *   <div v-for="(msg, i) in messages.value" :key="msg.id ?? i">
 *     {{ msg.content }}
 *   </div>
 * </template>
 * ```
 *
 * @example With type parameters for full type safety:
 * ```vue
 * <script setup lang="ts">
 * import { useStreamContext } from "@langchain/vue";
 * import type { agent } from "./agent";
 *
 * const { toolCalls } = useStreamContext<typeof agent>();
 * </script>
 * ```
 */
export function useStreamContext<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  const context = inject(STREAM_CONTEXT_KEY);
  if (context == null) {
    throw new Error(
      "useStreamContext() requires a parent component to call provideStream(). " +
        "Add provideStream({ assistantId: '...' }) in an ancestor component."
    );
  }
  return context;
}
