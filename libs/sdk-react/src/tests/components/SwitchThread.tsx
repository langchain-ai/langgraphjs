import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { UseStreamTransportPayload } from "@langchain/langgraph-sdk/ui";

import { useStreamCustom } from "../../stream.custom.js";

const transport = {
  async stream(payload: UseStreamTransportPayload) {
    const threadId = payload.config?.configurable?.thread_id ?? "unknown";
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

export function SwitchThread() {
  const thread = useStreamCustom<{ messages: BaseMessage[] }>({
    transport,
    threadId: null,
    onThreadId: () => {},
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
        data-testid="switch-thread"
        onClick={() => thread.switchThread(crypto.randomUUID())}
      >
        Switch Thread
      </button>
      <button
        data-testid="switch-thread-null"
        onClick={() => thread.switchThread(null)}
      >
        Switch to Null Thread
      </button>
    </div>
  );
}
