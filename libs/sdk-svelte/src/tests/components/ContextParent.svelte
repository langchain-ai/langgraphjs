<script lang="ts">
  import { provideStream } from "../../index.js";
  import ContextChild from "./ContextChild.svelte";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = provideStream({ assistantId, apiUrl });
</script>

<div data-testid="parent">
  <div data-testid="parent-loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="parent-message-count">{stream.messages.length}</div>
  <button
    data-testid="parent-submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Hello" }] } as any,
      )}
  >
    Send
  </button>
  <ContextChild />
</div>
