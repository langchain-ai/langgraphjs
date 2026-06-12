<script lang="ts">
  import { HumanMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";
  import type { BaseMessage } from "@langchain/core/messages";

  interface Props {
    apiUrl: string;
    assistantId?: string;
    initialValues: {
      messages: BaseMessage[];
      [key: string]: unknown;
    };
  }

  const {
    apiUrl,
    assistantId = "stategraph_text",
    initialValues,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream({
    assistantId,
    apiUrl,
    initialValues,
  });
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="values">{JSON.stringify(stream.values)}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({
        messages: [new HumanMessage("Fresh request")],
      })}
  >
    Submit
  </button>
</div>
