<script lang="ts">
  import { onMount } from "svelte";

  import MultiInterruptReloadSession from "./MultiInterruptReloadSession.svelte";

  /**
   * Parallel-interrupt harness whose `reload` button remounts `useStream` on
   * the same thread, like a page refresh, so a test can check what the
   * server kept rather than what the client still shows.
   */
  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  /** Milliseconds the session stays unmounted during a reload. */
  const RELOAD_GAP_MS = 100;

  const { apiUrl, assistantId = "multi_interrupt_graph" }: Props = $props();

  let threadId = $state<string | null>(null);
  let session = $state(0);
  let mounted = $state(true);
  let reloadTimer: number | undefined;

  onMount(() => () => window.clearTimeout(reloadTimer));

  function reload() {
    mounted = false;
    reloadTimer = window.setTimeout(() => {
      session += 1;
      mounted = true;
    }, RELOAD_GAP_MS);
  }
</script>

<div>
  <div data-testid="session">{session}</div>
  <button data-testid="reload" onclick={reload}>Reload</button>
  {#key session}
    {#if mounted}
      <MultiInterruptReloadSession
        {apiUrl}
        {assistantId}
        {threadId}
        onThreadId={(id) => {
          threadId = id;
        }}
      />
    {/if}
  {/key}
</div>
