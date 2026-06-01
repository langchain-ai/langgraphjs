<script lang="ts">
  import {
    useMessages,
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
  const messages = useMessages(props.stream, () => props.subagent);
</script>

<div data-testid={`obs-${props.id}`}>
  <div data-testid={`obs-${props.id}-count`}>{messages.current.length}</div>
  <div data-testid={`obs-${props.id}-namespace`}>
    {props.subagent.namespace.join("/")}
  </div>
  <div data-testid={`obs-${props.id}-types`}>
    {messages.current.map((m) => m.getType()).join(",")}
  </div>
</div>
