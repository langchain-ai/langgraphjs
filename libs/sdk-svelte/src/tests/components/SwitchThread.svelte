<script lang="ts">
  import { useStreamCustom } from "../../stream.custom.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const transport = {
    async stream(payload: any) {
      const threadId =
        payload.config?.configurable?.thread_id ?? "unknown";
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "values",
          data: {
            messages: [
              {
                id: `${threadId}-human`,
                type: "human",
                content: `Hello from ${threadId.slice(0, 8)}`,
              },
              {
                id: `${threadId}-ai`,
                type: "ai",
                content: `Reply on ${threadId.slice(0, 8)}`,
              },
            ],
          },
        };
      }
      return generate();
    },
  };

  const stream = useStreamCustom<{ messages: Message[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
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
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{stream.messages.length}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hi" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => stream.switchThread(crypto.randomUUID())}
  >
    Switch Thread
  </button>
  <button
    data-testid="switch-thread-null"
    onclick={() => stream.switchThread(null)}
  >
    Switch to Null Thread
  </button>
</div>
