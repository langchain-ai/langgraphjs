<script lang="ts">
  import { useStream, HttpAgentServerAdapter } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  const threadId = crypto.randomUUID();
  // svelte-ignore state_referenced_locally
  const transport = new HttpAgentServerAdapter({ apiUrl, threadId });

  // svelte-ignore state_referenced_locally
  const stream = useStream({ transport, assistantId, threadId });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Hello" }] } as any,
      )}
  >
    Send
  </button>
</div>
