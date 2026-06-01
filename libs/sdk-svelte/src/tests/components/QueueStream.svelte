<script lang="ts">
  import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
  import { useStream, useSubmissionQueue } from "../../index.js";
  import { formatMessage } from "./format.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  interface StreamState {
    messages: BaseMessage[];
    [key: string]: unknown;
  }

  const { apiUrl, assistantId = "slow_graph" }: Props = $props();

  let threadId = $state<string | null>(null);

  // svelte-ignore state_referenced_locally
  const stream = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId: () => threadId,
    onThreadId: (id) => {
      threadId = id;
    },
  });

  const queue = useSubmissionQueue(stream);

  function enqueue(content: string) {
    void stream.submit(
      { messages: [new HumanMessage(content)] },
      { multitaskStrategy: "enqueue" },
    );
  }

  const entriesText = $derived(
    queue.entries
      .map((entry) => {
        const messages = (entry.values as StreamState | undefined)?.messages;
        const first = Array.isArray(messages) ? messages[0] : undefined;
        return first ? formatMessage(first) : "?";
      })
      .join(","),
  );
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={"message-" + i}>{formatMessage(msg)}</div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="queue-size">{queue.size}</div>
  <div data-testid="queue-entries">{entriesText}</div>
  <button
    data-testid="submit-first"
    onclick={() => enqueue("Msg1")}
  >
    Submit First
  </button>
  <button
    data-testid="submit-three"
    onclick={() => {
      enqueue("Msg2");
      enqueue("Msg3");
      enqueue("Msg4");
    }}
  >
    Submit Three
  </button>
  <button
    data-testid="cancel-first"
    onclick={() => {
      const first = queue.entries[0];
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
    onclick={() => {
      threadId = crypto.randomUUID();
    }}
  >
    Switch Thread
  </button>
</div>
