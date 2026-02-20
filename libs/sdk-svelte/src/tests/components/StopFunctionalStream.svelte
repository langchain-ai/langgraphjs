<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    onStopMutate: (prev: any) => any;
  }

  const { apiUrl, assistantId = "agent", onStopMutate }: Props = $props();

  const { values, isLoading, submit, stop } = useStream({
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
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="counter">
    {($values as any).counter}
  </div>
  <div data-testid="items">
    {($values as any).items?.join(", ")}
  </div>
  <button data-testid="submit" onclick={() => void submit({} as any)}>
    Send
  </button>
  <button data-testid="stop" onclick={() => void stop()}>Stop</button>
</div>
