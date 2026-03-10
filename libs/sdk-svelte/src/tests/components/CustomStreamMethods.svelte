<script lang="ts">
  import { useStreamCustom } from "../../stream.custom.js";
  import type { Message } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl: _apiUrl }: Props = $props();

  const transport = {
    async stream() {
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "messages/metadata",
          data: { langgraph_node: "agent" },
        };
        yield {
          event: "messages/partial",
          data: [
            {
              id: "ai-1",
              type: "ai",
              content: "Hello!",
            },
          ],
        };
        yield {
          event: "values",
          data: {
            messages: [
              { id: "human-1", type: "human", content: "Hi" },
              { id: "ai-1", type: "ai", content: "Hello!" },
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

  const { messages, isLoading, branch } = thread;
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      {@const metadata = thread.getMessagesMetadata(msg as any, i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
        {#if metadata?.streamMetadata}
          <span data-testid={`metadata-${i}`}>
            {(metadata.streamMetadata as any).langgraph_node}
          </span>
        {/if}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="branch">{$branch}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void thread.submit({ messages: [{ type: "human", content: "Hi" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="set-branch"
    onclick={() => thread.setBranch("test-branch")}
  >
    Set Branch
  </button>
</div>
