<script lang="ts">
  import { onDestroy } from "svelte";
  import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
  import {
    STREAM_CONTROLLER,
    useStream,
    type SubagentDiscoverySnapshot,
    type SubgraphDiscoverySnapshot,
  } from "../../index.js";
  import ParallelFanoutCardPanel from "./ParallelFanoutCardPanel.svelte";

  type Card = SubagentDiscoverySnapshot | SubgraphDiscoverySnapshot;

  interface Props {
    apiUrl: string;
    assistantId: string;
    kind: "subagent" | "subgraph";
    openAll?: boolean;
    threadId: string | undefined;
    onThreadId: (id: string) => void;
    wrappedFetch: typeof fetch;
  }

  const props: Props = $props();

  function cardKey(card: Card): string {
    return card.namespace.join("/") || card.id;
  }

  // svelte-ignore state_referenced_locally
  const stream = useStream<{ messages: BaseMessage[] }>({
    assistantId: props.assistantId,
    apiUrl: props.apiUrl,
    threadId: () => props.threadId,
    onThreadId: props.onThreadId,
    fetch: props.wrappedFetch,
  });

  let openKey = $state<string | null>(null);
  let tick = $state(0);
  const interval = setInterval(() => {
    tick += 1;
  }, 25);
  onDestroy(() => clearInterval(interval));

  // Count of mounted panels whose scoped messages have landed — lets the
  // "open all" test wait for every card's lazy resolve to settle.
  const readySet = new Set<string>();
  let readyCount = $state(0);
  function markReady(key: string, ready: boolean) {
    if (ready === readySet.has(key)) return;
    if (ready) readySet.add(key);
    else readySet.delete(key);
    readyCount = readySet.size;
  }

  const cards = $derived(
    (props.kind === "subagent"
      ? [...stream.subagents.values()]
      : [...stream.subgraphs.values()]
    )
      .slice()
      .sort((a, b) => cardKey(a).localeCompare(cardKey(b))),
  );
  const openCard = $derived(cards.find((c) => cardKey(c) === openKey) ?? null);
  const registrySize = $derived.by(() => {
    void tick;
    return stream[STREAM_CONTROLLER].registry.size;
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="subagent-count">{stream.subagents.size}</div>
  <div data-testid="subgraph-count">{stream.subgraphs.size}</div>
  <div data-testid="card-count">{cards.length}</div>
  <div data-testid="card-statuses">{cards.map((c) => c.status).join(",")}</div>
  <div data-testid="panels-ready">{readyCount}</div>
  <div data-testid="registry-size">{registrySize}</div>

  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [new HumanMessage("Fan out the work")] })}
  >
    Run
  </button>

  {#each cards as card, i (cardKey(card))}
    <button
      data-testid={`open-${i}`}
      onclick={() => {
        openKey = cardKey(card);
      }}
    >
      Open {i}
    </button>
  {/each}

  {#if props.openAll}
    {#each cards as card, i (cardKey(card))}
      <ParallelFanoutCardPanel {stream} {card} idx={i} onReady={markReady} />
    {/each}
  {:else if openCard}
    <ParallelFanoutCardPanel {stream} card={openCard} />
  {/if}
</div>
