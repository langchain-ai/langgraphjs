<script lang="ts">
  import type { Message } from "@langchain/langgraph-sdk";
  import type { UseStreamTransport } from "../../index.js";
  import { useStreamCustom } from "../../stream.custom.js";

  type StreamState = { messages: Message[] };

  interface Props {
    streamTransport: UseStreamTransport<StreamState>["stream"];
  }

  let { streamTransport }: Props = $props();

  const stream = useStreamCustom<StreamState>({
    transport: {
      stream: (payload) => streamTransport(payload),
    },
    threadId: null,
    onThreadId: () => {},
  });
</script>

<button
  data-testid="submit-custom-subgraphs"
  onclick={() =>
    void stream.submit(
      { messages: [{ type: "human", content: "Hi" } as Message] },
      { streamSubgraphs: true },
    )}
>
  Submit
</button>
