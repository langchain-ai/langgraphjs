<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import { formatMessage } from "./format.js";

  interface StreamState {
    messages: BaseMessage[];
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

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
</script>

<div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="thread-id">{stream.threadId ?? "none"}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>{formatMessage(msg)}</div>
    {/each}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Hello" }] } as any,
      )}
  >
    Send
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => {
      threadId = crypto.randomUUID();
    }}
  >
    Switch
  </button>
  <button
    data-testid="switch-thread-null"
    onclick={() => {
      threadId = null;
    }}
  >
    Clear
  </button>
</div>
