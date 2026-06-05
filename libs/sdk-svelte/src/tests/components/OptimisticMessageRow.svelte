<script lang="ts">
  import type { BaseMessage } from "@langchain/core/messages";
  import { useMessageMetadata, type AnyStream } from "../../index.js";

  interface Props {
    stream: AnyStream;
    index: number;
    message: BaseMessage;
  }

  const { stream, index, message }: Props = $props();

  // svelte-ignore state_referenced_locally
  const metadata = useMessageMetadata(stream, () => message.id);

  function content(): string {
    return typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  }
</script>

<div data-testid={`message-${index}`}>
  <span data-testid={`message-${index}-content`}>{content()}</span>
  <span data-testid={`message-${index}-status`}>
    {metadata.current?.optimisticStatus ?? "none"}
  </span>
</div>
