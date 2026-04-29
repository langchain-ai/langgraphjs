<script lang="ts">
  import {
    useToolCalls,
    type AnyStream,
    type SubagentDiscoverySnapshot,
  } from "../../index.js";

  interface Props {
    stream: AnyStream;
    subagent: SubagentDiscoverySnapshot;
    id: string;
  }

  const { stream, subagent, id }: Props = $props();
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(stream, subagent);
</script>

<div data-testid={`obs-${id}`}>
  <div data-testid={`obs-${id}-count`}>{toolCalls.current.length}</div>
  <div data-testid={`obs-${id}-names`}>
    {toolCalls.current.map((tc) => tc.name).join(",")}
  </div>
</div>
