import type { Message } from "@langchain/langgraph-sdk";
import { StreamProvider, useStreamContext } from "../../index.js";

function MessageList() {
  const { messages } = useStreamContext<{ messages: Message[] }>();
  return (
    <div data-testid="messages">
      {messages.map((msg, i) => (
        <div key={msg.id ?? i} data-testid={`message-${i}`}>
          {typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)}
        </div>
      ))}
    </div>
  );
}

function StatusBar() {
  const { isLoading, error } = useStreamContext<{ messages: Message[] }>();
  return (
    <div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
      {error ? <div data-testid="error">{String(error)}</div> : null}
    </div>
  );
}

function SubmitButton({
  submitInput,
}: {
  submitInput: Record<string, unknown>;
}) {
  const { submit, stop } = useStreamContext<{ messages: Message[] }>();
  return (
    <div>
      <button data-testid="submit" onClick={() => void submit(submitInput)}>
        Send
      </button>
      <button data-testid="stop" onClick={() => void stop()}>
        Stop
      </button>
    </div>
  );
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  submitInput?: Record<string, unknown>;
}

export function ContextProvider({
  apiUrl,
  assistantId = "agent",
  submitInput = { messages: [{ content: "Hello", type: "human" }] },
}: Props) {
  return (
    <StreamProvider assistantId={assistantId} apiUrl={apiUrl}>
      <MessageList />
      <StatusBar />
      <SubmitButton submitInput={submitInput} />
    </StreamProvider>
  );
}
