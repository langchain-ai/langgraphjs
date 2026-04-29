<script lang="ts">
  import { useStream } from "../../index.js";
  import { formatMessage } from "./format.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  let threadId = $state<string | null>(null);

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
    threadId: () => threadId,
    onThreadId: (id) => {
      threadId = id;
    },
  });
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>{formatMessage(msg)}</div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hi" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => {
      threadId = crypto.randomUUID();
    }}
  >
    Switch Thread
  </button>
  <button
    data-testid="switch-thread-null"
    onclick={() => {
      threadId = null;
    }}
  >
    Switch to Null Thread
  </button>
</div>
