import type { Message } from "@langchain/langgraph-sdk";
import { useStreamCustom } from "../../stream.custom.js";

let callCount = 0;

const transport = {
  async stream(payload: any) {
    const threadId = payload.config?.configurable?.thread_id ?? "unknown";
    const idx = ++callCount;
    async function* generate(): AsyncGenerator<{
      event: string;
      data: unknown;
    }> {
      // Simulate a small delay so queue behavior is observable
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

export function QueueStream() {
  const thread = useStreamCustom<{ messages: Message[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
    queue: true,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={(msg as any).id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <div data-testid="queue-size">{thread.queue.size}</div>
      <div data-testid="queue-entries">
        {thread.queue.entries
          .map((e) => {
            const msgs = (e.values as any)?.messages;
            return msgs?.[0]?.content ?? "?";
          })
          .join(",")}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [{ type: "human", content: "Hi" }],
          } as any)
        }
      >
        Submit
      </button>
      <button
        data-testid="submit-three"
        onClick={() => {
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
        onClick={() => {
          const first = thread.queue.entries[0];
          if (first) thread.queue.cancel(first.id);
        }}
      >
        Cancel First
      </button>
      <button
        data-testid="clear-queue"
        onClick={() => thread.queue.clear()}
      >
        Clear Queue
      </button>
      <button
        data-testid="switch-thread"
        onClick={() => thread.switchThread(crypto.randomUUID())}
      >
        Switch Thread
      </button>
    </div>
  );
}
