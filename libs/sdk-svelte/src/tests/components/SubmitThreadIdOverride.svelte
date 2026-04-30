<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    submitThreadId: string;
  }

  const { apiUrl, assistantId = "agent", submitThreadId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="thread-id">{stream.threadId ?? "none"}</div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Hello" }] } as any,
        { threadId: submitThreadId },
      )}
  >
    Send
  </button>
</div>
