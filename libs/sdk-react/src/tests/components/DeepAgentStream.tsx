import { useRef } from "react";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

export function DeepAgentStream({ apiUrl }: Props) {
  const thread = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl,
    filterSubagentMessages: true,
  });

  const toolCallStatesRef = useRef(new Set<string>());

  const subagents = [...thread.subagents.values()].sort((a, b) => {
    const typeA = a.toolCall?.args?.subagent_type ?? "";
    const typeB = b.toolCall?.args?.subagent_type ?? "";
    return typeA.localeCompare(typeB);
  });

  for (const sub of subagents) {
    const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
    for (const tc of sub.toolCalls) {
      toolCallStatesRef.current.add(`${subType}:${tc.call.name}:${tc.state}`);
    }
  }

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
            [{msg.type}] {formatMessage(msg)}
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
            <div data-testid={`subagent-${subType}-messages-count`}>
              {sub.messages.length}
            </div>
            <div data-testid={`subagent-${subType}-toolcalls-count`}>
              {sub.toolCalls.length}
            </div>
            <div data-testid={`subagent-${subType}-toolcall-names`}>
              {sub.toolCalls.map((tc) => tc.call.name).join(",")}
            </div>
          </div>
        );
      })}

      <div data-testid="observed-toolcall-states">
        {[...toolCallStatesRef.current].sort().join(",")}
      </div>

      <hr />
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            { messages: [{ content: "Run analysis", type: "human" }] },
            { streamSubgraphs: true },
          )
        }
      >
        Send
      </button>
    </div>
  );
}

function formatMessage(msg: BaseMessage): string {
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

  if (ToolMessage.isInstance(msg)) {
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
