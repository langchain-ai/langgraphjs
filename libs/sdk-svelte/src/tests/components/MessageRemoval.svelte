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

  const stream = useStream({
    assistantId,
    apiUrl,
    throttle: false,
  });

  $effect(() => {
    const rawMessages = stream.messages.map(
      (msg: Message) =>
        `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`,
    );
    onRender?.(rawMessages);
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      {@const content = `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`}
      <div data-testid={`message-${i}`}>
        <span>{content}</span>
      </div>
    {/each}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
