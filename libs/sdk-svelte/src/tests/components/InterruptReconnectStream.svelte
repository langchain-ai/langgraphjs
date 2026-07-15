<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { useStream } from "../../index.js";
  import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
  import { createDroppableAuthFetch } from "../fixtures/droppable-auth-fetch.js";
  import { formatMessage } from "./format.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const {
    apiUrl,
    assistantId = "interruptAgent",
  }: Props = $props();

  const droppable = createDroppableAuthFetch();
  let reconnectCount = $state(0);
  let eventOpens = $state(0);
  let timer: number | undefined;

  onMount(() => {
    timer = window.setInterval(() => {
      eventOpens = droppable.eventStreamOpenCount();
    }, 50);
  });
  onDestroy(() => {
    if (timer != null) window.clearInterval(timer);
  });

  const stream = useStream<
    { messages: BaseMessage[] },
    { nodeName?: string }
  >({
    assistantId,
    apiUrl,
    fetch: droppable.fetch,
    maxReconnectAttempts: 5,
    reconnectDelayMs: () => 0,
    streamIdleReconnect: 0,
    onReconnect: () => {
      reconnectCount += 1;
      eventOpens = droppable.eventStreamOpenCount();
    },
  });

  const interruptNode = $derived(
    (stream.interrupt?.value as { nodeName?: string } | undefined)?.nodeName ??
      "",
  );

  const lastMessage = $derived(
    stream.messages.length ? formatMessage(stream.messages.at(-1)!) : "",
  );
</script>

<div>
  <div data-testid="interrupt-count">{stream.interrupts.length}</div>
  <div data-testid="interrupt-id">{stream.interrupt?.id ?? ""}</div>
  <div data-testid="interrupt-node">{interruptNode}</div>
  <div data-testid="last-message">{lastMessage}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="reconnect-count">{reconnectCount}</div>
  <div data-testid="event-stream-opens">{eventOpens}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [new HumanMessage("ship it")] })}
  >
    Send
  </button>
  <button
    data-testid="drop-events"
    onclick={() => {
      droppable.dropActiveStreams();
      eventOpens = droppable.eventStreamOpenCount();
    }}
  >
    Drop events
  </button>
  {#if stream.interrupt}
    <button
      data-testid="resume"
      onclick={() => {
        void stream.respond("approved");
      }}
    >
      Resume
    </button>
  {/if}
</div>
