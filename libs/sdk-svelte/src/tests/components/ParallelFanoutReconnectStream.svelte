<script lang="ts">
  import ParallelFanoutStreamView from "./ParallelFanoutStreamView.svelte";

  interface Props {
    apiUrl: string;
    assistantId: string;
    kind: "subagent" | "subgraph";
    openAll?: boolean;
    openAllAfterReconnect?: boolean;
  }

  const {
    apiUrl,
    assistantId,
    kind,
    openAll = false,
    openAllAfterReconnect = false,
  }: Props = $props();

  let threadId = $state<string | undefined>(undefined);
  let gen = $state(0);
  let historyCount = $state(0);

  // Counts `/history` POSTs so the test can assert the bounded
  // getHistory invariant after reconnect.
  const wrappedFetch: typeof fetch = (input, init) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (typeof url === "string" && url.includes("/history")) historyCount += 1;
    } catch {
      /* ignore */
    }
    return fetch(input, init);
  };

  function reconnect() {
    historyCount = 0;
    gen += 1;
  }

  function onThreadId(id: string) {
    threadId = id;
  }
</script>

<div>
  <button
    data-testid="reconnect"
    disabled={threadId == null}
    onclick={reconnect}
  >
    Reconnect
  </button>
  <div data-testid="history-request-count">{historyCount}</div>

  {#key gen}
    <ParallelFanoutStreamView
      {apiUrl}
      {assistantId}
      {kind}
      openAll={openAll || (openAllAfterReconnect && gen > 0)}
      {threadId}
      {onThreadId}
      {wrappedFetch}
    />
  {/key}
</div>
