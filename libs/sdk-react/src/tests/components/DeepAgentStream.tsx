import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";

import type { DeepAgentGraph } from "../fixtures/mock-server.js";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

export function DeepAgentStream({ apiUrl }: Props) {
  const thread = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
  });

  const subagents = [...thread.subagents.values()].sort((a, b) => {
    const typeA = a.toolCall?.args?.subagent_type ?? "";
    const typeB = b.toolCall?.args?.subagent_type ?? "";
    return typeA.localeCompare(typeB);
  });

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>

      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}

      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>

      <div data-testid="subagent-count">{subagents.length}</div>

      {subagents.map((sub) => {
        const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
        return (
          <div key={sub.id} data-testid={`subagent-${subType}`}>
            <div data-testid={`subagent-${subType}-status`}>
              SubAgent ({subType}) status: {sub.status}
            </div>
            <div data-testid={`subagent-${subType}-task-description`}>
              {sub.toolCall?.args?.description ?? ""}
            </div>
            <div data-testid={`subagent-${subType}-result`}>
              {sub.result ?? ""}
            </div>
            <div data-testid={`subagent-${subType}-messages`}>
              {sub.messages.map((msg, j) => (
                <div
                  key={msg.id ?? j}
                  data-testid={`subagent-${subType}-msg-${j}`}
                >
                  {formatMessage(msg)}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [{ content: "Run analysis", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

function formatMessage(msg: BaseMessage): string {
  const type = msg._getType();

  if (
    AIMessage.isInstance(msg) &&
    "tool_calls" in msg &&
    msg.tool_calls &&
    msg.tool_calls.length > 0
  ) {
    const toolCalls = msg.tool_calls;
    return toolCalls
      .map((tc) => `tool_call:${tc.name}:${JSON.stringify(tc.args)}`)
      .join(",");
  }

  if (type === "tool") {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    return `tool_result:${content}`;
  }

  return typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
}
