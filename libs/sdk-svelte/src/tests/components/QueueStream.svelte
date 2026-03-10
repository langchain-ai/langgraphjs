<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const {
    messages,
    isLoading,
    queue,
    submit,
    switchThread,
  } = useStream({
    assistantId: "agent",
    apiUrl,
    fetchStateHistory: false,
  });

  const queueEntries = queue.entries;
  const queueSize = queue.size;
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div data-testid={"message-" + i}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{$messages.length}</div>
  <div data-testid="queue-size">{$queueSize}</div>
  <div data-testid="queue-entries">
    {$queueEntries
      .map((e) => e.values?.messages?.[0]?.content ?? "?")
      .join(",")}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void submit({ messages: [{ content: "Hi", type: "human" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="submit-three"
    onclick={() => {
      void submit({
        messages: [{ content: "Msg1", type: "human" }],
      } as any);
      void submit({
        messages: [{ content: "Msg2", type: "human" }],
      } as any);
      void submit({
        messages: [{ content: "Msg3", type: "human" }],
      } as any);
    }}
  >
    Submit Three
  </button>
  <button
    data-testid="cancel-first"
    onclick={() => {
      const first = $queueEntries[0];
      if (first) void queue.cancel(first.id);
    }}
  >
    Cancel First
  </button>
  <button data-testid="clear-queue" onclick={() => void queue.clear()}>
    Clear Queue
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => switchThread(crypto.randomUUID())}
  >
    Switch Thread
  </button>
</div>
