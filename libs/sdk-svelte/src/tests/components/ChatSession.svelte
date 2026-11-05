<script lang="ts">
  import { untrack } from "svelte";
  import {
    AIMessage,
    HumanMessage,
    type BaseMessage,
  } from "@langchain/core/messages";

  import { useStream } from "../../index.js";
  import { formatMessage } from "./format.js";

  interface ChatState {
    messages: BaseMessage[];
  }

  interface Props {
    prefix: string;
    apiUrl: string;
    assistantId: string;
    threadId: string | null;
    onThreadId?: (threadId: string) => void;
    inputs: string[];
    respondValue?: unknown;
    fetch?: typeof globalThis.fetch;
    transport?: "sse" | "websocket";
  }

  const {
    prefix,
    apiUrl,
    assistantId,
    threadId,
    onThreadId,
    inputs,
    respondValue,
    fetch,
    transport,
  }: Props = $props();

  /**
   * {@link formatMessage}, with text content blocks flattened to their text
   * so a streamed reply reads the same as a checkpointed one.
   */
  function formatChatMessage(message: BaseMessage): string {
    if (Array.isArray(message.content)) {
      const blocks = message.content as Array<{
        type?: unknown;
        text?: unknown;
      }>;
      if (blocks.every((block) => block.type === "text")) {
        return blocks.map((block) => String(block.text ?? "")).join("");
      }
    }
    return formatMessage(message);
  }

  let completed = $state(0);
  let respondError = $state("");
  let submitError = $state("");

  // svelte-ignore state_referenced_locally
  const thread = useStream<ChatState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
    fetch,
    transport,
    onCompleted: () => {
      completed += 1;
    },
  });

  const lastText = $derived(
    thread.messages.length > 0
      ? formatChatMessage(thread.messages[thread.messages.length - 1])
      : ""
  );

  let countHistory = $state<number[]>([]);
  $effect(() => {
    if (thread.isThreadLoading) return;
    const count = thread.messages.length;
    untrack(() => {
      if (countHistory.at(-1) !== count) {
        countHistory = [...countHistory, count];
      }
    });
  });

  let wasLoading = false;
  let settledWith = $state<string[]>([]);
  $effect(() => {
    const loading = thread.isLoading;
    const text = lastText;
    if (wasLoading && !loading) {
      untrack(() => {
        settledWith = [...settledWith, text];
      });
    }
    wasLoading = loading;
  });

  const id = (name: string) => `${prefix}${name}`;

  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
</script>

<div>
  <div data-testid={id("message-count")}>{thread.messages.length}</div>
  <div data-testid={id("transcript")}>
    {thread.messages.map(formatChatMessage).join(" | ")}
  </div>
  <div data-testid={id("ai-tool-calls")}>
    {thread.messages
      .filter((message) => AIMessage.isInstance(message))
      .flatMap(
        (message) =>
          (message as AIMessage).tool_calls?.map((call) => call.id) ?? []
      )
      .join(",")}
  </div>
  <div data-testid={id("loading")}>
    {thread.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid={id("thread-loading")}>
    {thread.isThreadLoading ? "Hydrating..." : "Ready"}
  </div>
  <div data-testid={id("interrupt-count")}>{thread.interrupts.length}</div>
  <div data-testid={id("error")}>
    {thread.error ? String(thread.error) : ""}
  </div>
  <div data-testid={id("respond-error")}>{respondError}</div>
  <div data-testid={id("submit-error")}>{submitError}</div>
  <div data-testid={id("count-history")}>{countHistory.join(",")}</div>
  <div data-testid={id("settled-with")}>{settledWith.join(" || ")}</div>
  <div data-testid={id("completed-count")}>{completed}</div>
  {#each inputs as input, i (input)}
    <button
      data-testid={id(`submit-${i}`)}
      onclick={() => {
        submitError = "";
        void thread
          .submit({ messages: [new HumanMessage(input)] })
          .catch((error: unknown) => {
            submitError = errorMessage(error);
          });
      }}
    >
      {input}
    </button>
  {/each}
  <button data-testid={id("stop")} onclick={() => void thread.stop()}>
    Stop
  </button>
  <button
    data-testid={id("respond")}
    onclick={() => {
      respondError = "";
      void thread.respond(respondValue).catch((error: unknown) => {
        respondError = errorMessage(error);
      });
    }}
  >
    Respond
  </button>
</div>
