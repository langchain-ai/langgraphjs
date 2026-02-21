<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  const { submit, messages, getMessagesMetadata, setBranch } = useStream({
    assistantId,
    apiUrl,
    fetchStateHistory: true,
  });
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      {@const metadata = getMessagesMetadata(msg, i)}
      {@const checkpoint =
        metadata?.firstSeenState?.parent_checkpoint ?? undefined}
      {@const text =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      {@const branchOptions = metadata?.branchOptions}
      {@const branch = metadata?.branch}
      {@const branchIndex =
        branchOptions && branch ? branchOptions.indexOf(branch) : -1}

      <div data-testid={`message-${i}`}>
        <div data-testid={`content-${i}`}>{text}</div>

        {#if branchOptions && branch}
          <div data-testid={`branch-nav-${i}`}>
            <button
              data-testid={`prev-${i}`}
              onclick={() => {
                const prevBranch = branchOptions[branchIndex - 1];
                if (prevBranch) setBranch(prevBranch);
              }}
            >
              Previous
            </button>
            <span data-testid={`branch-info-${i}`}>
              {branchIndex + 1} / {branchOptions.length}
            </span>
            <button
              data-testid={`next-${i}`}
              onclick={() => {
                const nextBranch = branchOptions[branchIndex + 1];
                if (nextBranch) setBranch(nextBranch);
              }}
            >
              Next
            </button>
          </div>
        {/if}

        {#if msg.type === "human"}
          <button
            data-testid={`fork-${i}`}
            onclick={() =>
              void submit(
                {
                  messages: [
                    { type: "human", content: `Fork: ${text}` },
                  ],
                } as any,
                { checkpoint },
              )}
          >
            Fork
          </button>
        {/if}

        {#if msg.type === "ai"}
          <button
            data-testid={`regenerate-${i}`}
            onclick={() => void submit(undefined as any, { checkpoint })}
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
      void submit({
        messages: [{ content: "Hello", type: "human" }],
      } as any)}
  >
    Send
  </button>
</div>
