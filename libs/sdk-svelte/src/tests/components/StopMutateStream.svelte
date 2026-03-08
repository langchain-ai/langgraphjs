<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    onStopMutate: (prev: any) => any;
  }

  const { apiUrl, assistantId = "agent", onStopMutate }: Props = $props();

  let stopped = $state(false);

  const { messages, isLoading, submit, stop } = useStream<{
    messages: Message[];
  }>({
    assistantId,
    apiUrl,
    onStop: ({ mutate }: any) => {
      stopped = true;
      mutate(onStopMutate);
    },
  });
</script>

<div>
  <div data-testid="stopped-status">
    {stopped ? "Stopped" : "Not stopped"}
  </div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
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
      void submit({
        messages: [{ content: "Hello", type: "human" }],
      } as any)}
  >
    Send
  </button>
  <button data-testid="stop" onclick={() => void stop()}>Stop</button>
</div>
