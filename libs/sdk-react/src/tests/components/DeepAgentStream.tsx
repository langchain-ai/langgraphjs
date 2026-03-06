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
    <div
      data-testid="deep-agent-root"
      style={{ fontFamily: "monospace", fontSize: 13 }}
    >
      <div data-testid="loading">
        <b>Status:</b> {thread.isLoading ? "Loading..." : "Not loading"}
      </div>

      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}

      <hr />
      <div>
        <b>Messages ({thread.messages.length})</b>
      </div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            [{msg._getType()}] {formatMessage(msg)}
          </div>
        ))}
      </div>

      <hr />
      <div>
        <b>Subagents</b> (
        <span data-testid="subagent-count">{subagents.length}</span>)
      </div>

      {subagents.map((sub) => {
        const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
        return (
          <div
            key={sub.id}
            data-testid={`subagent-${subType}`}
            style={{
              margin: "8px 0",
              paddingLeft: 12,
              borderLeft: "2px solid #999",
            }}
          >
            <div data-testid={`subagent-${subType}-status`}>
              SubAgent ({subType}) status: {sub.status}
            </div>
            <div data-testid={`subagent-${subType}-task-description`}>
              Task: {sub.toolCall?.args?.description ?? ""}
            </div>
            <div data-testid={`subagent-${subType}-result`}>
              Result: {sub.result ?? ""}
            </div>
          </div>
        );
      })}

      <hr />
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
    return msg.tool_calls
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
