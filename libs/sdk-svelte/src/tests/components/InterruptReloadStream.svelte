<script lang="ts">
  import { onMount } from "svelte";

  import { createDurableReplayFetch } from "../fixtures/durable-replay-fetch.js";
  import InterruptReloadSession from "./InterruptReloadSession.svelte";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();
  const durable = createDurableReplayFetch();
  let threadId = $state<string>();
  let session = $state(0);
  let mounted = $state(true);
  let replayedFrames = $state(0);
  let reloadTimer: number | undefined;

  onMount(() => {
    const replayTimer = window.setInterval(() => {
      replayedFrames = durable.replayedFrameCount();
    }, 50);
    return () => {
      window.clearInterval(replayTimer);
      window.clearTimeout(reloadTimer);
    };
  });

  function reload() {
    mounted = false;
    reloadTimer = window.setTimeout(() => {
      session += 1;
      mounted = true;
    }, 100);
  }
</script>

<div data-testid="session">{session}</div>
<div data-testid="replayed-frames">{replayedFrames}</div>
<button data-testid="reload" onclick={reload}>Reload</button>
{#key session}
  {#if mounted}
    <InterruptReloadSession
      {apiUrl}
      {threadId}
      onThreadId={(id) => (threadId = id)}
      fetch={durable.fetch}
    />
  {/if}
{/key}
