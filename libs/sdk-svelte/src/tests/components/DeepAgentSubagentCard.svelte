<script lang="ts">
  import { useMessages, useToolCalls } from "../../index.js";
  import type { AnyStream, SubagentDiscoverySnapshot } from "../../index.js";

  interface Props {
    stream: AnyStream;
    subagent: SubagentDiscoverySnapshot;
  }

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  const messages = useMessages(props.stream, () => props.subagent);
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(props.stream, () => props.subagent);

  const subType = $derived(props.subagent.name ?? "unknown");
</script>

<div
  data-testid={`subagent-${subType}`}
  style="margin: 8px 0; padding-left: 12px; border-left: 2px solid #999"
>
  <div data-testid={`subagent-${subType}-status`}>
    SubAgent ({subType}) status: {props.subagent.status}
  </div>
  <div data-testid={`subagent-${subType}-namespace`}>
    {props.subagent.namespace.join("/")}
  </div>
  <div data-testid={`subagent-${subType}-task-description`}>
    Task: {props.subagent.taskInput ?? ""}
  </div>
  <div data-testid={`subagent-${subType}-result`}>
    Result: {typeof props.subagent.output === "string"
      ? props.subagent.output
      : JSON.stringify(props.subagent.output)}
  </div>
  <div data-testid={`subagent-${subType}-messages-count`}>
    {messages.current.length}
  </div>
  <div data-testid={`subagent-${subType}-toolcalls-count`}>
    {toolCalls.current.length}
  </div>
  <div data-testid={`subagent-${subType}-toolcall-names`}>
    {toolCalls.current.map((tc) => tc.name).join(",")}
  </div>
</div>
