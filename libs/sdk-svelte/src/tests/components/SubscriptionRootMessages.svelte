<script lang="ts">
  import { useMessages, type AnyStream } from "../../index.js";

  interface Props {
    stream: AnyStream;
  }

  const { stream }: Props = $props();
  // svelte-ignore state_referenced_locally
  const messages = useMessages(stream);
</script>

<div data-testid="root-observer-count">{messages.current.length}</div>
