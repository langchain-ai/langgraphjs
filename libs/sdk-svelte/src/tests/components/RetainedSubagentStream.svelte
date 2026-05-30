<script lang="ts">
  import { useStream, useToolCalls, type AnyStream } from "../../index.js";
  import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
  });

  const retainedSubagent = $derived(
    [...stream.subagents.values()].find((sub) => sub.name === "researcher"),
  );
  const retainedToolCalls = useToolCalls(stream as AnyStream, () => retainedSubagent);

  const retainedStatus = $derived(retainedSubagent?.status ?? "missing");
  const retainedToolCallCount = $derived(retainedToolCalls.current.length);
  const retainedTask = $derived(retainedSubagent?.taskInput ?? "");
  const retainedLatestToolName = $derived(
    retainedToolCalls.current.at(-1)?.name ?? "missing"
  );
  const retainedLatestToolArgs = $derived.by(() => {
    const input = retainedToolCalls.current.at(-1)?.input;
    return typeof input === "string" ? input : JSON.stringify(input ?? {});
  });
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
      void stream.submit({
        messages: [{ content: "Run analysis", type: "human" }],
      })}
  >
    Send
  </button>
</div>
