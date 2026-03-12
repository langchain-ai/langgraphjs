import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function StreamMetadata({ apiUrl, assistantId = "agent" }: Props) {
  const { messages, submit, getMessagesMetadata } = useStream({
    assistantId,
    apiUrl,
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => {
          const metadata = getMessagesMetadata(msg, i);
          return (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
              {metadata?.streamMetadata && (
                <div data-testid="stream-metadata">
                  {metadata.streamMetadata?.langgraph_node as string}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
