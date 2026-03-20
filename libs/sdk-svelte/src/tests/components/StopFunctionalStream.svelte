<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    onStopMutate: (prev: any) => any;
  }

  const { apiUrl, assistantId = "agent", onStopMutate }: Props = $props();

  const stream = useStream({
    assistantId,
    apiUrl,
    initialValues: {
      counter: 5,
      items: ["item1", "item2"],
    },
    onStop: ({ mutate }: any) => {
      mutate(onStopMutate);
    },
  });
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="counter">
    {(stream.values as any).counter}
  </div>
  <div data-testid="items">
    {(stream.values as any).items?.join(", ")}
  </div>
  <button data-testid="submit" onclick={() => void stream.submit({} as any)}>
    Send
  </button>
  <button data-testid="stop" onclick={() => void stream.stop()}>Stop</button>
</div>
