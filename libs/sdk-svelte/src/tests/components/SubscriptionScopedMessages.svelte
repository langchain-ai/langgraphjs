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

  const { stream, subagent, id }: Props = $props();
  // svelte-ignore state_referenced_locally
  const messages = useMessages(stream, subagent);
</script>

<div data-testid={`obs-${id}`}>
  <div data-testid={`obs-${id}-count`}>{messages.current.length}</div>
  <div data-testid={`obs-${id}-namespace`}>
    {subagent.namespace.join("/")}
  </div>
  <div data-testid={`obs-${id}-types`}>
    {messages.current.map((m) => m.getType()).join(",")}
  </div>
</div>
