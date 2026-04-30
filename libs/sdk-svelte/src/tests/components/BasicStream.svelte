<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    threadId?: string;
    submitInput?: Record<string, unknown>;
    submitOptions?: Record<string, unknown>;
    transport?: "sse" | "websocket";
    onThreadId?: (threadId: string) => void;
    onCreated?: (meta: { run_id: string; thread_id: string }) => void;
  }

  const {
    apiUrl,
    assistantId = "agent",
    threadId,
    submitInput = { messages: [{ content: "Hello", type: "human" }] },
    submitOptions,
    transport,
    onThreadId,
    onCreated,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream({
    assistantId,
    apiUrl,
    threadId,
    transport,
    onThreadId,
    onCreated,
  });
</script>

<div>
  <div data-testid="message-count">{stream.messages.length}</div>
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
  <div data-testid="thread-id">{stream.threadId ?? "none"}</div>
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
