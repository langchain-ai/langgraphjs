<script lang="ts">
  import { AIMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";
  import DeepAgentSubagentCard from "./DeepAgentSubagentCard.svelte";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
  });

  const toolCallStates = new Set<string>();
  const subagentStatuses = new Set<string>();
  let observedToolCallStates = $state("");
  let observedSubagentStatuses = $state("");

  const sortedSubagents = $derived(
    [...stream.subagents.values()].sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? ""),
    ),
  );

  $effect(() => {
    for (const sub of sortedSubagents) {
      const subType = sub.name ?? "unknown";
      subagentStatuses.add(`${subType}:${sub.status}`);
    }
    observedToolCallStates = [...toolCallStates].sort().join(",");
    observedSubagentStatuses = [...subagentStatuses].sort().join(",");
  });

  function formatMessage(msg: any): string {
    if (AIMessage.isInstance(msg)) {
      return (
        msg.tool_calls
          ?.map((tc: any) => `tool_call:${tc.name}:${JSON.stringify(tc.args)}`)
          .join(",") ?? ""
      );
    }
    if (msg.type === "tool") {
      return `tool_result:${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`;
    }
    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }
</script>

<div
  data-testid="deep-agent-root"
  style="font-family: monospace; font-size: 13px"
>
  <div data-testid="loading">
    <b>Status:</b>
    {stream.isLoading ? "Loading..." : "Not loading"}
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
  <div data-testid="root-toolcall-count">{stream.toolCalls.length}</div>
  <div data-testid="root-toolcall-names">
    {stream.toolCalls.map((tc) => tc.name).join(",")}
  </div>

  <hr />
  <div>
    <b>Subagents</b> (<span data-testid="subagent-count"
      >{sortedSubagents.length}</span
    >)
  </div>
  <div data-testid="subagent-names">
    {sortedSubagents.map((sub) => sub.name).join(",")}
  </div>

  {#each sortedSubagents as sub (sub.id)}
    <DeepAgentSubagentCard {stream} subagent={sub} />
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
    onclick={() =>
      void stream.submit({
        messages: [{ content: "Run analysis", type: "human" }],
      })}
  >
    Send
  </button>
</div>
