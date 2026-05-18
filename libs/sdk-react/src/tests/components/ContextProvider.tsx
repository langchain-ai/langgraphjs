import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { StreamProvider, useStreamContext } from "../../index.js";

type StreamState = { messages: BaseMessage[] };

function MessageList() {
  const { messages } = useStreamContext<StreamState>();
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
  const { isLoading, error } = useStreamContext<StreamState>();
  return (
    <div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
      {error ? <div data-testid="error">{String(error)}</div> : null}
    </div>
  );
}

function SubmitButton() {
  const { submit, stop } = useStreamContext<StreamState>();
  return (
    <div>
      <button
        data-testid="submit"
        onClick={() =>
          void submit({ messages: [new HumanMessage("Hello")] })
        }
      >
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
}

export function ContextProvider({
  apiUrl,
  assistantId = "stategraph_text",
}: Props) {
  return (
    <StreamProvider<StreamState> assistantId={assistantId} apiUrl={apiUrl}>
      <MessageList />
      <StatusBar />
      <SubmitButton />
    </StreamProvider>
  );
}
