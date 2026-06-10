<script lang="ts">
  import { useStream, useChannelEffect, type Channel } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    channels?: Channel[];
    enabled?: boolean;
  }

  const {
    apiUrl,
    assistantId = "customChannelAgent",
    channels = ["custom"],
    enabled = true,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream({ assistantId, apiUrl });

  let count = $state(0);
  let methods = $state<string[]>([]);

  // svelte-ignore state_referenced_locally
  useChannelEffect(stream, channels, {
    enabled,
    replay: false,
    onEvent(event) {
      count += 1;
      methods = [...methods, event.method ?? ""];
    },
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="effect-count">{count}</div>
  <div data-testid="effect-methods">{methods.join(",")}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Trigger custom writer" }] } as any,
      )}
  >
    Submit
  </button>
</div>
