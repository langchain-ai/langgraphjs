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

  const stream = useStream({
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
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.error}
    <div data-testid="error">{String(stream.error)}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() => void stream.submit(submitInput as any, submitOptions as any)}
  >
    Send
  </button>
  <button data-testid="stop" onclick={() => void stream.stop()}>Stop</button>
</div>
