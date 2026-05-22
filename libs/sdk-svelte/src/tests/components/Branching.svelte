<script lang="ts">
  import { useMessageMetadata, useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  const stream = useStream({
    assistantId,
    apiUrl,
  });
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      {@const metadata = useMessageMetadata(stream, () => msg.id)}
      {@const checkpoint = metadata.current?.parentCheckpointId}
      {@const text =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}

      <div data-testid={`message-${i}`}>
        <div data-testid={`content-${i}`}>{text}</div>

        {#if msg.type === "human"}
          <button
            data-testid={`fork-${i}`}
            onclick={() =>
              void stream.submit(
                {
                  messages: [
                    { type: "human", content: `Fork: ${text}` },
                  ],
                } as any,
                checkpoint ? { forkFrom: { checkpointId: checkpoint } } : {},
              )}
          >
            Fork
          </button>
        {/if}

        {#if msg.type === "ai"}
          <button
            data-testid={`regenerate-${i}`}
            onclick={() =>
              void stream.submit(
                undefined,
                checkpoint ? { forkFrom: { checkpointId: checkpoint } } : {},
              )}
          >
            Regenerate
          </button>
        {/if}
      </div>
    {/each}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({
        messages: [{ content: "Hello", type: "human" }],
      } as any)}
  >
    Send
  </button>
</div>
