<script lang="ts">
  import { useStream } from "../../index.js";
  import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
  import { formatMessage } from "./format.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    useRespondMethod?: boolean;
  }

  const {
    apiUrl,
    assistantId = "interruptAgent",
    useRespondMethod = false,
  }: Props = $props();

  const stream = useStream<
    { messages: BaseMessage[] },
    { nodeName?: string }
  >({
    assistantId,
    apiUrl,
  });

  const interruptNode = $derived(
    (stream.interrupt?.value as { nodeName?: string } | undefined)?.nodeName ??
      "",
  );

  const lastMessage = $derived(
    stream.messages.length ? formatMessage(stream.messages.at(-1)!) : "",
  );
</script>

<div>
  <div data-testid="interrupt-count">{stream.interrupts.length}</div>
  <div data-testid="interrupt-id">{stream.interrupt?.id ?? ""}</div>
  <div data-testid="interrupt-node">{interruptNode}</div>
  <div data-testid="last-message">{lastMessage}</div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>{formatMessage(msg)}</div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.interrupt}
    <div>
      <div data-testid="interrupt">
        {interruptNode}
      </div>
      <button
        data-testid="resume"
        onclick={() => {
          if (useRespondMethod) {
            void stream.respond("approved");
          } else {
            void stream.submit(undefined, {
              command: { resume: "approved" },
            });
          }
        }}
      >
        Resume
      </button>
    </div>
  {/if}
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [new HumanMessage("ship it")] })}
  >
    Send
  </button>
</div>
