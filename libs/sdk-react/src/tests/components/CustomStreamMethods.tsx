import type { BaseMessage } from "@langchain/core/messages";
import { useStreamCustom } from "../../stream.custom.js";

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

export function CustomStreamMethods() {
  const thread = useStreamCustom<{ messages: BaseMessage[] }>({
    transport,
    threadId: null,
    onThreadId: () => {},
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => {
          const metadata = thread.getMessagesMetadata(msg, i);
          return (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
              {metadata?.streamMetadata && (
                <span data-testid={`metadata-${i}`}>
                  {
                    (metadata.streamMetadata as Record<string, string>)
                      .langgraph_node
                  }
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div data-testid="branch">{thread.branch}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [
              { type: "human", content: "Hi" } as unknown as BaseMessage,
            ],
          })
        }
      >
        Submit
      </button>
      <button
        data-testid="set-branch"
        onClick={() => thread.setBranch("test-branch")}
      >
        Set Branch
      </button>
    </div>
  );
}
