<script lang="ts">
  import { useStream } from "../../index.js";
  import type { UseStreamOptions } from "@langchain/langgraph-sdk/ui";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    options: UseStreamOptions<any, any>;
  }

  const { options }: Props = $props();

  const { messages, values, submit } = useStream(options);
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div
        data-testid={msg.id?.includes("cached")
          ? `message-cached-${i}`
          : `message-${i}`}
      >
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="values">{JSON.stringify($values)}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Submit
  </button>
</div>
