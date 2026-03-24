<script lang="ts">
  import { useStream } from "../../index.js";
  import { Client, type Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    client: Client;
  }

  const { apiUrl, assistantId = "agent", client }: Props = $props();

  const stream = useStream({
    assistantId,
    apiUrl,
    client,
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
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        { messages: [{ content: "Hello", type: "human" }] } as any,
      )}
  >
    Send
  </button>
</div>
