<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  let onStopCalled = $state(false);
  let hasMutate = $state(false);

  const { submit, stop } = useStream({
    assistantId,
    apiUrl,
    onStop: (arg: any) => {
      onStopCalled = true;
      hasMutate = typeof arg?.mutate === "function";
    },
  });
</script>

<div>
  <div data-testid="onstop-called">{onStopCalled ? "Yes" : "No"}</div>
  <div data-testid="has-mutate">{hasMutate ? "Yes" : "No"}</div>
  <button data-testid="submit" onclick={() => void submit({} as any)}>
    Send
  </button>
  <button data-testid="stop" onclick={() => void stop()}>Stop</button>
</div>
