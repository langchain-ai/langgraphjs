<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const PRESETS = ["Msg1", "Msg2", "Msg3"];

  let pending: string[] = [];

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
    fetchStateHistory: false,
    onCreated: () => {
      if (pending.length > 0) {
        const followUps = pending;
        pending = [];
        for (const text of followUps) {
          void stream.submit({
            messages: [{ content: text, type: "human" }],
          } as any);
        }
      }
    },
  });

  function onSubmitPresets() {
    pending = PRESETS.slice(1);
    void stream.submit({
      messages: [{ content: PRESETS[0], type: "human" }],
    } as any);
  }
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={"message-" + i}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <div data-testid="queue-size">{stream.queue.size}</div>
  <button data-testid="submit-presets" onclick={onSubmitPresets}>
    Submit Presets
  </button>
</div>
