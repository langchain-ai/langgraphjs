<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    onRender?: (messages: string[]) => void;
  }

  const { apiUrl, assistantId = "agent", onRender }: Props = $props();

  const { messages, isLoading, submit } = useStream({
    assistantId,
    apiUrl,
  });

  $effect(() => {
    const rawMessages = $messages.map(
      (msg: Message) =>
        `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`,
    );
    onRender?.(rawMessages);
  });
</script>

<div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      {@const content = `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`}
      <div data-testid={`message-${i}`}>
        <span>{content}</span>
      </div>
    {/each}
  </div>
  <button
    data-testid="submit-first"
    onclick={() =>
      void submit({
        messages: [{ content: "Hello (1)", type: "human" }],
      } as any)}
  >
    Send First
  </button>
  <button
    data-testid="submit-second"
    onclick={() =>
      void submit({
        messages: [{ content: "Hello (2)", type: "human" }],
      } as any)}
  >
    Send Second
  </button>
</div>
