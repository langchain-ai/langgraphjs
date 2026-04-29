<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";

  interface StreamState {
    messages: BaseMessage[];
  }

  interface Props {
    apiUrl: string;
    assistantId: string;
    threadId: string;
  }

  const { apiUrl, assistantId, threadId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const secondary = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
  });
</script>

<div>
  <div data-testid="secondary-mounted">yes</div>
  <div data-testid="secondary-loading">
    {secondary.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="secondary-thread-id">{secondary.threadId ?? "none"}</div>
  <div data-testid="secondary-message-count">{secondary.messages.length}</div>
</div>
