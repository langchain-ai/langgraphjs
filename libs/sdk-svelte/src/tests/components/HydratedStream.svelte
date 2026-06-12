<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import { formatMessage } from "./format.js";

  interface Props {
    apiUrl: string;
    threadId: string;
    delayMs?: number;
  }

  const { apiUrl, threadId, delayMs = 0 }: Props = $props();

  let hydrated = $state(false);

  // svelte-ignore state_referenced_locally
  const stream = useStream<{ messages: BaseMessage[] }>({
    assistantId: "stategraph_text",
    apiUrl,
    threadId,
  });

  void Promise.all([
    stream.hydrationPromise,
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
  ]).then(() => {
    hydrated = true;
  });
</script>

{#if !hydrated}
  <div data-testid="hydration-fallback">Hydrating</div>
{:else}
  <div>
    <div data-testid="hydrated">ready</div>
    <div data-testid="message-count">{stream.messages.length}</div>
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>{formatMessage(msg)}</div>
    {/each}
  </div>
{/if}
