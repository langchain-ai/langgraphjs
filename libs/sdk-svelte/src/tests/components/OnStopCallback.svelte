<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  let onStopCalled = $state(false);
  let hasMutate = $state(false);

  const stream = useStream({
    assistantId,
    apiUrl,
    onStop: (arg: any) => {
      onStopCalled = true;
      hasMutate = typeof arg?.mutate === "function";
    },
  });
</script>

<div>
  <div data-testid="loading">{stream.isLoading ? "Loading..." : "Not loading"}</div>
  <div data-testid="onstop-called">{onStopCalled ? "Yes" : "No"}</div>
  <div data-testid="has-mutate">{hasMutate ? "Yes" : "No"}</div>
  <button data-testid="submit" onclick={() => void stream.submit({} as any)}>
    Send
  </button>
  <button data-testid="stop" onclick={() => void stream.stop()}>Stop</button>
</div>
