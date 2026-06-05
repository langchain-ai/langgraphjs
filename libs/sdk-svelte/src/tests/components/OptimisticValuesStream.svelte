<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";

  interface StreamState {
    messages: BaseMessage[];
    status?: string;
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
    optimistic?: boolean;
    submitStatus?: string;
  }

  const {
    apiUrl,
    assistantId = "stateful_values_graph",
    optimistic,
    submitStatus = "draft",
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<StreamState>({ assistantId, apiUrl, optimistic });

  function content(msg: BaseMessage): string {
    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }
</script>

<div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>{content(msg)}</div>
    {/each}
  </div>
  <div data-testid="status">{stream.values.status ?? "none"}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.error}
    <div data-testid="error">{String(stream.error)}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({
        messages: [{ type: "human", content: "Hello" }],
        status: submitStatus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)}
  >
    Send
  </button>
</div>
