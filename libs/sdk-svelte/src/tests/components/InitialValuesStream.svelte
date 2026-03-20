<script lang="ts">
  import { useStream } from "../../index.js";
  import type { UseStreamOptions } from "@langchain/langgraph-sdk/ui";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    options: UseStreamOptions<any, any>;
  }

  const { options }: Props = $props();

  const stream = useStream(options);
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
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
  <div data-testid="values">{JSON.stringify(stream.values)}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Submit
  </button>
</div>
