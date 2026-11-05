<script lang="ts">
  import { onMount } from "svelte";

  import {
    createDurableReplayFetch,
    type DurableReplayFetchOptions,
  } from "../fixtures/durable-replay-fetch.js";
  import ChatSession from "./ChatSession.svelte";

  /**
   * Chat harness for streaming regressions that only show up across views
   * of one thread:
   *
   * - `reload` unmounts the primary `useStream` and mounts a fresh one on
   *   the same thread, like a page refresh.
   * - `observer-mount` opens a second, independent `useStream` on the
   *   thread, like another tab. Its test ids are prefixed with `observer-`.
   *
   * Each session also records what a user would have seen over time:
   * `count-history` lists every message count shown once hydration
   * finished, and `settled-with` the last message shown each time
   * `isLoading` cleared.
   */
  interface Props {
    apiUrl: string;
    assistantId: string;
    /** One `submit-<i>` button per entry, sending it as a human message. */
    inputs?: string[];
    /** Payload of the `respond` button. */
    respondValue?: unknown;
    /**
     * Give the primary session LangGraph Platform's durable event history:
     * every `/stream/events` open replays what earlier opens received.
     */
    replay?: Omit<DurableReplayFetchOptions, "baseFetch">;
    transport?: "sse" | "websocket";
  }

  /** Milliseconds the primary session stays unmounted during a reload. */
  const RELOAD_GAP_MS = 100;

  const {
    apiUrl,
    assistantId,
    inputs = ["Hello"],
    respondValue,
    replay,
    transport,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const durable = replay ? createDurableReplayFetch(replay) : undefined;
  let threadId = $state<string | null>(null);
  let session = $state(0);
  let mounted = $state(true);
  let observer = $state(false);
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
  <div data-testid="thread-id">{threadId ?? "none"}</div>
  <button data-testid="reload" onclick={reload}>Reload</button>
  <button
    data-testid="observer-mount"
    disabled={threadId == null}
    onclick={() => {
      observer = true;
    }}
  >
    Open observer
  </button>
  {#key session}
    {#if mounted}
      <ChatSession
        prefix=""
        {apiUrl}
        {assistantId}
        {threadId}
        onThreadId={(id) => {
          threadId = id;
        }}
        {inputs}
        {respondValue}
        fetch={durable?.fetch}
        {transport}
      />
    {/if}
  {/key}
  {#if observer && threadId != null}
    <ChatSession
      prefix="observer-"
      {apiUrl}
      {assistantId}
      {threadId}
      {inputs}
      {respondValue}
    />
  {/if}
</div>
