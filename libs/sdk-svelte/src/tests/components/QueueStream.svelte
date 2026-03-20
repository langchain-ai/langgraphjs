<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
    fetchStateHistory: false,
  });
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={"message-" + i}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="queue-size">{stream.queue.size}</div>
  <div data-testid="queue-entries">
    {stream.queue.entries
      .map((e) => e.values?.messages?.[0]?.content ?? "?")
      .join(",")}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ content: "Hi", type: "human" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="submit-three"
    onclick={() => {
      void stream.submit({
        messages: [{ content: "Msg1", type: "human" }],
      } as any);
      void stream.submit({
        messages: [{ content: "Msg2", type: "human" }],
      } as any);
      void stream.submit({
        messages: [{ content: "Msg3", type: "human" }],
      } as any);
    }}
  >
    Submit Three
  </button>
  <button
    data-testid="cancel-first"
    onclick={() => {
      const first = stream.queue.entries[0];
      if (first) void stream.queue.cancel(first.id);
    }}
  >
    Cancel First
  </button>
  <button data-testid="clear-queue" onclick={() => void stream.queue.clear()}>
    Clear Queue
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => stream.switchThread(crypto.randomUUID())}
  >
    Switch Thread
  </button>
</div>
