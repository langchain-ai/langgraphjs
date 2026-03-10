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

  const thread = useStreamCustom<{ messages: Message[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
  });

  const { messages, isLoading } = thread;
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="message-count">{$messages.length}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void thread.submit({ messages: [{ type: "human", content: "Hi" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => thread.switchThread(crypto.randomUUID())}
  >
    Switch Thread
  </button>
  <button
    data-testid="switch-thread-null"
    onclick={() => thread.switchThread(null)}
  >
    Switch to Null Thread
  </button>
</div>
