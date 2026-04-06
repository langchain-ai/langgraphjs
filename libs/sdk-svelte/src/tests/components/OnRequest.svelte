<script lang="ts">
  import { useStream } from "../../index.js";
  import { Client } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    client: Client;
    fetchStateHistory?: boolean | { limit: number };
  }

  const {
    apiUrl,
    assistantId = "agent",
    client,
    fetchStateHistory,
  }: Props = $props();

  const stream = useStream({
    assistantId,
    apiUrl,
    client,
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
