<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    fetchStateHistory?: boolean;
  }

  const {
    apiUrl,
    assistantId = "interruptAgent",
    fetchStateHistory = false,
  }: Props = $props();

  const { messages, interrupt, submit } = useStream<
    { messages: Message[] },
    { InterruptType: { nodeName: string } }
  >({
    assistantId,
    apiUrl,
    fetchStateHistory,
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
  {#if $interrupt}
    <div>
      <div data-testid="interrupt">
        {$interrupt.when ?? $interrupt.value?.nodeName}
      </div>
      <button
        data-testid="resume"
        onclick={() =>
          void submit(null as any, { command: { resume: "Resuming" } })}
      >
        Resume
      </button>
    </div>
  {/if}
  <button
    data-testid="submit"
    onclick={() =>
      void submit(
        { messages: [{ content: "Hello", type: "human" }] } as any,
        { interruptBefore: ["beforeInterrupt"] },
      )}
  >
    Send
  </button>
</div>
