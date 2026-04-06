<script lang="ts">
  import { useStream } from "../../index.js";
  import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
    filterSubagentMessages: true,
  });

  const toolCallStates = new Set<string>();
  const subagentStatuses = new Set<string>();
  let observedToolCallStates = $state("");
  let observedSubagentStatuses = $state("");

  const sortedSubagents = $derived(
    [...stream.subagents.values()].sort((a: any, b: any) => {
      const typeA = a.toolCall?.args?.subagent_type ?? "";
      const typeB = b.toolCall?.args?.subagent_type ?? "";
      return typeA.localeCompare(typeB);
    })
  );

  $effect(() => {
    for (const sub of sortedSubagents) {
      const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
      subagentStatuses.add(`${subType}:${sub.status}`);
      for (const tc of sub.toolCalls) {
        toolCallStates.add(`${subType}:${tc.call.name}:${tc.state}`);
      }
    }
    observedToolCallStates = [...toolCallStates].sort().join(",");
    observedSubagentStatuses = [...subagentStatuses].sort().join(",");
  });

  function formatMessage(msg: any): string {
    if (msg.type === "ai" && msg.tool_calls?.length) {
      return msg.tool_calls
        .map((tc: any) => `tool_call:${tc.name}:${JSON.stringify(tc.args)}`)
        .join(",");
    }
    if (msg.type === "tool") {
      return `tool_result:${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`;
    }
    return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  }
</script>

<div data-testid="deep-agent-root" style="font-family: monospace; font-size: 13px">
  <div data-testid="loading">
    <b>Status:</b> {stream.isLoading ? "Loading..." : "Not loading"}
  </div>

  {#if stream.error}
    <div data-testid="error">{String(stream.error)}</div>
  {/if}

  <hr />
  <div><b>Messages ({stream.messages.length})</b></div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        [{msg.type}] {formatMessage(msg)}
      </div>
    {/each}
  </div>

  <hr />
  <div><b>Subagents</b> (<span data-testid="subagent-count">{sortedSubagents.length}</span>)</div>

  {#each sortedSubagents as sub (sub.id)}
    {@const subType = sub.toolCall?.args?.subagent_type ?? "unknown"}
    <div data-testid={`subagent-${subType}`}
      style="margin: 8px 0; padding-left: 12px; border-left: 2px solid #999">
      <div data-testid={`subagent-${subType}-status`}>
        SubAgent ({subType}) status: {sub.status}
      </div>
      <div data-testid={`subagent-${subType}-task-description`}>
        Task: {sub.toolCall?.args?.description ?? ""}
      </div>
      <div data-testid={`subagent-${subType}-result`}>
        Result: {sub.result ?? ""}
      </div>
      <div data-testid={`subagent-${subType}-messages-count`}>
        {sub.messages.length}
      </div>
      <div data-testid={`subagent-${subType}-toolcalls-count`}>
        {sub.toolCalls.length}
      </div>
      <div data-testid={`subagent-${subType}-toolcall-names`}>
        {sub.toolCalls.map((tc) => tc.call.name).join(",")}
      </div>
    </div>
  {/each}

  <div data-testid="observed-toolcall-states">
    {observedToolCallStates}
  </div>
  <div data-testid="observed-subagent-statuses">
    {observedSubagentStatuses}
  </div>

  <hr />
  <button
    data-testid="submit"
    onclick={() => void stream.submit({ messages: [{ content: "Run analysis", type: "human" }] }, { streamSubgraphs: true })}
  >
    Send
  </button>
</div>
