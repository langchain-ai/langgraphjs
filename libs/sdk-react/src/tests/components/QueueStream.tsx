import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { UseStreamTransportPayload } from "@langchain/langgraph-sdk/ui";

import { useStreamCustom } from "../../stream.custom.js";

let callCount = 0;

const transport = {
  async stream(payload: UseStreamTransportPayload) {
    const threadId = payload.config?.configurable?.thread_id ?? "unknown";
    // eslint-disable-next-line no-plusplus
    const idx = ++callCount;
    async function* generate(): AsyncGenerator<{
      event: string;
      data: unknown;
    }> {
      // Simulate a small delay so queue behavior is observable
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
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
  const thread = useStreamCustom<{ messages: BaseMessage[] }>({
    transport,
    threadId: null,
    onThreadId: () => {},
    queue: true,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
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
            const msgs = e.values?.messages;
            return msgs?.[0]?.content ?? "?";
          })
          .join(",")}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Hi")],
          })
        }
      >
        Submit
      </button>
      <button
        data-testid="submit-three"
        onClick={() => {
          void thread.submit({
            messages: [new HumanMessage("Msg1")],
          });
          void thread.submit({
            messages: [new HumanMessage("Msg2")],
          });
          void thread.submit({
            messages: [new HumanMessage("Msg3")],
          });
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
      <button data-testid="clear-queue" onClick={() => thread.queue.clear()}>
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
