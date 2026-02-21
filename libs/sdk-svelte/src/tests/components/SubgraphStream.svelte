<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    onCheckpointEvent?: (...args: any[]) => void;
    onUpdateEvent?: (...args: any[]) => void;
    onCustomEvent?: (...args: any[]) => void;
  }

  const {
    apiUrl,
    onCheckpointEvent,
    onUpdateEvent,
    onCustomEvent,
  }: Props = $props();

  const { messages, isLoading, submit } = useStream({
    assistantId: "parentAgent",
    apiUrl,
    onCheckpointEvent,
    onUpdateEvent,
    onCustomEvent,
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
    {$isLoading ? "Loading" : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void submit(
        { messages: [{ content: "Hello", type: "human" }] } as any,
        { streamSubgraphs: true },
      )}
  >
    Send
  </button>
</div>
