<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    transport?: "sse" | "websocket";
  }

  const {
    apiUrl,
    assistantId = "parentAgent",
    transport,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream({
    assistantId,
    apiUrl,
    transport,
  });

  const subgraphs = $derived([...stream.subgraphs.values()]);
  const subgraphsByNodeEntries = $derived(
    [...stream.subgraphsByNode.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading" : "Not loading"}
  </div>
  <div data-testid="subgraph-count">{subgraphs.length}</div>
  <div data-testid="subgraph-nodes">
    {subgraphsByNodeEntries
      .map(([node, entries]) => `${node}:${entries.length}`)
      .join(",")}
  </div>
  {#each subgraphs as subgraph, i (subgraph.id ?? i)}
    <div data-testid={`subgraph-${i}-namespace`}>
      {subgraph.namespace.join("/") || "root"}
    </div>
  {/each}
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        { messages: [{ content: "Hello", type: "human" }] } as any,
      )}
  >
    Send
  </button>
</div>
