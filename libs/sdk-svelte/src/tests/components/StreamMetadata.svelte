<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  const { messages, submit, getMessagesMetadata } = useStream({
    assistantId,
    apiUrl,
  });
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      {@const metadata = getMessagesMetadata(msg, i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}

        {#if metadata?.streamMetadata}
          <div data-testid="stream-metadata">
            {metadata.streamMetadata?.langgraph_node}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
