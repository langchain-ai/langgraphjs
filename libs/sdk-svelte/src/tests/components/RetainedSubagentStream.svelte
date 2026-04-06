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

  let retainedSubagent = $state<ReturnType<
    typeof stream.getSubagent
  >>();

  $effect(() => {
    const researcher = stream.getSubagentsByType("researcher")[0];
    if (researcher && !retainedSubagent) {
      retainedSubagent = researcher;
    }
  });

  const retainedStatus = $derived(retainedSubagent?.status ?? "missing");
  const retainedToolCallCount = $derived(retainedSubagent?.toolCalls.length ?? -1);
  const retainedTask = $derived(retainedSubagent?.toolCall?.args?.description ?? "");
  const retainedLatestToolName = $derived(
    retainedSubagent?.toolCalls.at(-1)?.call?.name ?? "missing"
  );
  const retainedLatestToolArgs = $derived(
    JSON.stringify(retainedSubagent?.toolCalls.at(-1)?.call?.args ?? {})
  );
</script>

<div data-testid="retained-subagent-root">
  <div data-testid="retained-subagent-status">{retainedStatus}</div>
  <div data-testid="retained-subagent-toolcalls">{retainedToolCallCount}</div>
  <div data-testid="retained-subagent-task">{retainedTask || "missing"}</div>
  <div data-testid="retained-subagent-latest-tool">{retainedLatestToolName}</div>
  <div data-testid="retained-subagent-latest-tool-args">{retainedLatestToolArgs}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        { messages: [{ content: "Run analysis", type: "human" }] },
        { streamSubgraphs: true },
      )}
  >
    Send
  </button>
</div>
