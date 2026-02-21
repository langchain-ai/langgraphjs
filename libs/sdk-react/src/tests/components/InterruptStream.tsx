import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  fetchStateHistory?: boolean;
}

export function InterruptStream({
  apiUrl,
  assistantId = "interruptAgent",
  fetchStateHistory = false,
}: Props) {
  const { messages, interrupt, submit } = useStream<
    { messages: Message[] },
    { InterruptType: { nodeName: string } }
  >({
    assistantId,
    apiUrl,
    fetchStateHistory,
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      {interrupt ? (
        <div>
          <div data-testid="interrupt">
            {interrupt.when ?? interrupt.value?.nodeName}
          </div>
          <button
            data-testid="resume"
            onClick={() =>
              void submit(null, { command: { resume: "Resuming" } })
            }
          >
            Resume
          </button>
        </div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void submit(
            { messages: [{ content: "Hello", type: "human" }] },
            { interruptBefore: ["beforeInterrupt"] }
          )
        }
      >
        Send
      </button>
    </div>
  );
}
