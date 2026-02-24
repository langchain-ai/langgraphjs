import type { Message } from "@langchain/langgraph-sdk";
import { useStreamCustom } from "../../stream.custom.js";

const transport = {
  async stream(payload: any) {
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
  const thread = useStreamCustom<{ messages: Message[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
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
