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

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(props.stream, () => props.subagent);
</script>

<div data-testid={`obs-${props.id}`}>
  <div data-testid={`obs-${props.id}-count`}>{toolCalls.current.length}</div>
  <div data-testid={`obs-${props.id}-names`}>
    {toolCalls.current.map((tc) => tc.name).join(",")}
  </div>
</div>
