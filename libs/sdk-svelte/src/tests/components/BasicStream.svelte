<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    submitInput?: Record<string, unknown>;
    submitOptions?: Record<string, unknown>;
    onCheckpointEvent?: (...args: any[]) => void;
    onTaskEvent?: (...args: any[]) => void;
    onUpdateEvent?: (...args: any[]) => void;
    onCustomEvent?: (...args: any[]) => void;
    fetchStateHistory?: boolean | { limit: number };
  }

  const {
    apiUrl,
    assistantId = "agent",
    submitInput = { messages: [{ content: "Hello", type: "human" }] },
    submitOptions,
    onCheckpointEvent,
    onTaskEvent,
    onUpdateEvent,
    onCustomEvent,
    fetchStateHistory,
  }: Props = $props();

  const { messages, isLoading, error, submit, stop } = useStream({
    assistantId,
    apiUrl,
    onCheckpointEvent,
    onTaskEvent,
    onUpdateEvent,
    onCustomEvent,
    fetchStateHistory,
  });
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if $error}
    <div data-testid="error">{String($error)}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() => void submit(submitInput as any, submitOptions as any)}
  >
    Send
  </button>
  <button data-testid="stop" onclick={() => void stop()}>Stop</button>
</div>
