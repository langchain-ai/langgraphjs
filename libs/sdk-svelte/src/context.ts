import { setContext, getContext } from "svelte";
import type { BagTemplate } from "@langchain/langgraph-sdk";
import type {
  ResolveStreamOptions,
  InferBag,
  InferStateType,
  UseStreamCustomOptions,
} from "@langchain/langgraph-sdk/ui";
import { useStream } from "./index.js";

const STREAM_CONTEXT_KEY = Symbol("langchain-stream");

/**
 * Creates a shared `useStream` instance and makes it available to all
 * descendant components via Svelte's `setContext`/`getContext`.
 *
 * Call this in a parent component's `<script>` block. Children access
 * the shared stream via `getStream()`.
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
 *
 * @returns The stream instance (same as calling `useStream` directly).
 */
export function provideStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options:
    | ResolveStreamOptions<T, InferBag<T, Bag>>
    | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
): ReturnType<typeof useStream<T, Bag>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = useStream<T, Bag>(options as any);
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * Retrieves the shared stream instance from the nearest ancestor that
 * called `provideStream()`.
 *
 * Throws if no ancestor has provided a stream.
 *
 * @example
 * ```svelte
 * <!-- MessageList.svelte -->
 * <script lang="ts">
 *   import { getStream } from "@langchain/svelte";
 *
 *   const { messages } = getStream();
 * </script>
 *
 * {#each $messages as msg (msg.id)}
 *   <div>{msg.content}</div>
 * {/each}
 * ```
 *
 * @example
 * ```svelte
 * <!-- MessageInput.svelte -->
 * <script lang="ts">
 *   import { getStream } from "@langchain/svelte";
 *
 *   const { submit, isLoading } = getStream();
 *   let input = $state("");
 *
 *   function send() {
 *     submit({ messages: [{ type: "human", content: input }] });
 *     input = "";
 *   }
 * </script>
 *
 * <form onsubmit={send}>
 *   <textarea bind:value={input}></textarea>
 *   <button disabled={$isLoading} type="submit">Send</button>
 * </form>
 * ```
 */
export function getStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  const context = getContext(STREAM_CONTEXT_KEY);
  if (context == null) {
    throw new Error(
      "getStream() requires a parent component to call provideStream(). " +
        "Add provideStream({ assistantId: '...' }) in an ancestor component.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return context as any;
}
