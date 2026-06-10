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
    idx?: number;
    onReady?: (key: string, ready: boolean) => void;
  }

  const props: Props = $props();

  function cardKey(card: Card): string {
    return card.namespace.join("/") || card.id;
  }

  // svelte-ignore state_referenced_locally
  const messages = useMessages(props.stream, () => props.card);
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(props.stream, () => props.card);

  $effect(() => {
    props.onReady?.(cardKey(props.card), messages.current.length > 0);
  });
</script>

<div data-testid={props.idx != null ? `panel-${props.idx}` : "panel"}>
  <div data-testid="panel-namespace">{props.card.namespace.join("/")}</div>
  <div data-testid="panel-messages-count">{messages.current.length}</div>
  <div data-testid="panel-toolcalls-count">{toolCalls.current.length}</div>
</div>
