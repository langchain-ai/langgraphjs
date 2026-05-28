<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useStream, useMessageMetadata } from "../../index.js";

  interface StreamState {
    messages: BaseMessage[];
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<StreamState>({ assistantId, apiUrl });

  // svelte-ignore state_referenced_locally
  const firstMetadata = useMessageMetadata(stream, () => stream.messages[0]?.id);

  function firstContent(): string {
    const msg = stream.messages[0];
    if (!msg) return "";
    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-0-content">{firstContent()}</div>
  <div data-testid="message-0-parent">
    {firstMetadata.current?.parentCheckpointId ?? "none"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
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
</div>
