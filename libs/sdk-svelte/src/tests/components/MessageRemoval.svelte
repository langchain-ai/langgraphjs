<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    onRender?: (messages: string[]) => void;
  }

  const {
    apiUrl,
    assistantId = "removeMessageAgent",
    onRender,
  }: Props = $props();

  const { messages, isLoading, submit } = useStream({
    assistantId,
    apiUrl,
    throttle: false,
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
    data-testid="submit"
    onclick={() =>
      void submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
