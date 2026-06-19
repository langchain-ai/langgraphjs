import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  initialValues: StreamState;
}

export function InitialValuesStream({
  apiUrl,
  assistantId = "stategraph_text",
  initialValues,
}: Props) {
  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
    initialValues,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? `cached-${i}`} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>
      <div data-testid="values">
        {thread.values?.messages
          ?.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          )
          .join("|") ?? ""}
      </div>
      <div data-testid="status-value">
        {typeof thread.values?.status === "string" ? thread.values.status : ""}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Fresh request")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

export const initialAICached = (id: string, content: string) =>
  new AIMessage({ id, content });

export const initialHumanCached = (id: string, content: string) =>
  new HumanMessage({ id, content });
