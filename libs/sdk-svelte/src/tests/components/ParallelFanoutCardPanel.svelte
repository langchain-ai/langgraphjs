<script lang="ts">
  import {
    useMessages,
    useToolCalls,
    type AnyStream,
    type SubagentDiscoverySnapshot,
    type SubgraphDiscoverySnapshot,
  } from "../../index.js";

  type Card = SubagentDiscoverySnapshot | SubgraphDiscoverySnapshot;

  interface Props {
    stream: AnyStream;
    card: Card;
  }

  const props: Props = $props();

  // svelte-ignore state_referenced_locally
  const messages = useMessages(props.stream, () => props.card);
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(props.stream, () => props.card);
</script>

<div data-testid="panel">
  <div data-testid="panel-namespace">{props.card.namespace.join("/")}</div>
  <div data-testid="panel-messages-count">{messages.current.length}</div>
  <div data-testid="panel-toolcalls-count">{toolCalls.current.length}</div>
</div>
