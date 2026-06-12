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

  const status = $derived(metadata.current?.optimisticStatus ?? "none");

  // Latch: the server echoes the input message id almost immediately, so
  // the live `pending` status is a sub-frame transient that a polling
  // assertion can race under suite load. Recording that we *ever* rendered
  // `pending` is sticky and race-free.
  let everPending = $state(false);
  $effect(() => {
    if (status === "pending") everPending = true;
  });

  function content(): string {
    return typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  }
</script>

<div data-testid={`message-${index}`}>
  <span data-testid={`message-${index}-content`}>{content()}</span>
  <span data-testid={`message-${index}-status`}>{status}</span>
  <span data-testid={`message-${index}-ever-pending`}>
    {everPending ? "true" : "false"}
  </span>
</div>
