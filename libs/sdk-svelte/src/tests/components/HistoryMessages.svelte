<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    threadId?: string | null;
    fetchStateHistory?: boolean | { limit: number };
  }

  const {
    apiUrl,
    threadId,
    fetchStateHistory = true,
  }: Props = $props();

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
    threadId,
    fetchStateHistory,
  });

  const historyMessages = $derived(
    stream.history.flatMap(
      (state: any) => (state.values.messages ?? []) as Record<string, unknown>[],
    ),
  );

  const allAreBaseMessage = $derived(
    historyMessages.length > 0 &&
    historyMessages.every(
      (msg: any) => typeof msg.getType === "function",
    ),
  );

  const messageTypes = $derived(
    historyMessages
      .map((msg: any) => {
        return typeof msg.getType === "function" ? msg.getType() : "plain";
      })
      .join(","),
  );
</script>

<div>
  <div data-testid="history-count">{stream.history.length}</div>
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
