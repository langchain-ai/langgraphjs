<script lang="ts">
  import { useStream } from "../../index.js";
  import type { DeepAgentGraph } from "../fixtures/mock-server.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  // svelte-ignore state_referenced_locally
  const { messages, isLoading, error, submit, subagents } = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
  });

  const sortedSubagents = $derived.by(() => {
    void $messages;
    void $isLoading;
    return [...subagents.values()].sort((a: any, b: any) => {
      const typeA = a.toolCall?.args?.subagent_type ?? "";
      const typeB = b.toolCall?.args?.subagent_type ?? "";
      return typeA.localeCompare(typeB);
    });
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

<div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>

  {#if $error}
    <div data-testid="error">{String($error)}</div>
  {/if}

  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {formatMessage(msg)}
      </div>
    {/each}
  </div>

  <div data-testid="subagent-count">{sortedSubagents.length}</div>

  {#each sortedSubagents as sub (sub.id)}
    {@const subType = sub.toolCall?.args?.subagent_type ?? "unknown"}
    <div data-testid={`subagent-${subType}`}>
      <div data-testid={`subagent-${subType}-status`}>
        SubAgent ({subType}) status: {sub.status}
      </div>
      <div data-testid={`subagent-${subType}-task-description`}>
        {sub.toolCall?.args?.description ?? ""}
      </div>
      <div data-testid={`subagent-${subType}-result`}>
        {sub.result ?? ""}
      </div>
    </div>
  {/each}

  <button
    data-testid="submit"
    onclick={() => void submit({ messages: [{ content: "Run analysis", type: "human" }] })}
  >
    Send
  </button>
</div>
