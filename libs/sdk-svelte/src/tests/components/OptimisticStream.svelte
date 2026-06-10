<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import OptimisticMessageRow from "./OptimisticMessageRow.svelte";

  interface StreamState {
    messages: BaseMessage[];
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
    optimistic?: boolean;
    submitText?: string;
  }

  const {
    apiUrl,
    assistantId = "stategraph_text",
    optimistic,
    submitText = "Hello",
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<StreamState>({ assistantId, apiUrl, optimistic });
</script>

<div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <OptimisticMessageRow {stream} index={i} message={msg} />
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
    onclick={() =>
      void stream.submit({
        messages: [{ type: "human", content: submitText }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)}
  >
    Send
  </button>
</div>
