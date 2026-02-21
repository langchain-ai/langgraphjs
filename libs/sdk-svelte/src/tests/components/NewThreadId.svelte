<script lang="ts">
  import { useStream } from "../../index.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    threadId?: string | null;
    onThreadId?: (threadId: string) => void;
    submitThreadId?: string;
  }

  const {
    apiUrl,
    assistantId = "agent",
    threadId = null,
    onThreadId,
    submitThreadId,
  }: Props = $props();

  const stream = useStream<{ messages: Message[] }>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });

  const { isLoading } = stream;
</script>

<div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="thread-id">Client ready</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({} as any, { threadId: submitThreadId })}
  >
    Submit
  </button>
</div>
