<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    threadId?: string | null;
  }

  const {
    apiUrl,
    threadId,
  }: Props = $props();

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
    threadId,
  });

  const allAreBaseMessage = $derived(
    stream.messages.length > 0 &&
    stream.messages.every((msg) => typeof msg.getType === "function"),
  );

  const messageTypes = $derived(
    stream.messages.map((msg) => msg.getType()).join(","),
  );
</script>

<div>
  <div data-testid="history-count">{stream.messages.length}</div>
  <div data-testid="history-all-base-message">{String(allAreBaseMessage)}</div>
  <div data-testid="history-message-types">{messageTypes}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() => void stream.submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
