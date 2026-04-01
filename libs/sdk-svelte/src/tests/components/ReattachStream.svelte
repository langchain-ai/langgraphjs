<script lang="ts">
  import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import ReattachSecondaryStream from "./ReattachSecondaryStream.svelte";

  interface StreamState {
    messages: BaseMessage[];
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "slow_graph" }: Props = $props();

  let threadId = $state<string | undefined>(undefined);
  let secondaryMounted = $state(false);

  // svelte-ignore state_referenced_locally
  const primary = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId: () => threadId,
    onThreadId: (id) => {
      threadId = id;
    },
  });
</script>

<div>
  <div data-testid="primary-loading">
    {primary.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="primary-thread-id">{primary.threadId ?? "none"}</div>
  <div data-testid="primary-message-count">{primary.messages.length}</div>

  <button
    data-testid="primary-submit"
    onclick={() =>
      void primary.submit({
        messages: [new HumanMessage("Hello")],
      })}
  >
    Start slow run
  </button>
  <button
    data-testid="secondary-mount"
    disabled={threadId == null}
    onclick={() => {
      secondaryMounted = true;
    }}
  >
    Mount secondary
  </button>
  <button
    data-testid="secondary-unmount"
    onclick={() => {
      secondaryMounted = false;
    }}
  >
    Unmount secondary
  </button>

  {#if secondaryMounted && threadId != null}
    <ReattachSecondaryStream {apiUrl} {assistantId} {threadId} />
  {:else}
    <div data-testid="secondary-mounted">no</div>
  {/if}
</div>
