<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  let submitError = $state<string | null>(null);

  const stream = useStream({
    assistantId: "errorAgent",
    apiUrl,
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.error}
    <div data-testid="error">{String(stream.error)}</div>
  {/if}
  {#if submitError}
    <div data-testid="submit-error">{submitError}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        { messages: [{ content: "Hello", type: "human" }] },
        {
          onError: (err: unknown) => {
            submitError =
              err instanceof Error ? err.message : String(err);
          },
        },
      )}
  >
    Send
  </button>
</div>
