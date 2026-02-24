<script lang="ts">
  import { useStreamCustom } from "../../stream.custom.js";
  import type { Message } from "@langchain/langgraph-sdk";
  import { derived } from "svelte/store";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  let callCount = 0;

  const transport = {
    async stream(payload: any) {
      const threadId =
        payload.config?.configurable?.thread_id ?? "unknown";
      const idx = ++callCount;
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield {
          event: "values",
          data: {
            messages: [
              {
                id: `${threadId}-human-${idx}`,
                type: "human",
                content: `Question ${idx}`,
              },
              {
                id: `${threadId}-ai-${idx}`,
                type: "ai",
                content: `Answer ${idx}`,
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
    queue: true,
  });

  const { messages, isLoading, queue } = thread;
  const queueSize = queue.size;
  const queueEntries = queue.entries;

  const queueEntriesLabel = derived(queueEntries, ($entries) =>
    $entries
      .map((e: any) => {
        const msgs = e.values?.messages;
        return msgs?.[0]?.content ?? "?";
      })
      .join(","),
  );
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
  <div data-testid="queue-size">{$queueSize}</div>
  <div data-testid="queue-entries">{$queueEntriesLabel}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void thread.submit({
        messages: [{ type: "human", content: "Hi" }],
      } as any)}
  >
    Submit
  </button>
  <button
    data-testid="submit-three"
    onclick={() => {
      void thread.submit({
        messages: [{ type: "human", content: "Msg1" }],
      } as any);
      void thread.submit({
        messages: [{ type: "human", content: "Msg2" }],
      } as any);
      void thread.submit({
        messages: [{ type: "human", content: "Msg3" }],
      } as any);
    }}
  >
    Submit Three
  </button>
  <button
    data-testid="cancel-first"
    onclick={() => {
      const first = $queueEntries[0];
      if (first) queue.cancel(first.id);
    }}
  >
    Cancel First
  </button>
  <button
    data-testid="clear-queue"
    onclick={() => queue.clear()}
  >
    Clear Queue
  </button>
  <button
    data-testid="switch-thread"
    onclick={() => thread.switchThread(crypto.randomUUID())}
  >
    Switch Thread
  </button>
</div>
