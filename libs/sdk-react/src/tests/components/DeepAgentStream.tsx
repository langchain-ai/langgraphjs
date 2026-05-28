import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";

import {
  useStream,
  useMessages,
  useToolCalls,
} from "../../index.js";
import { formatMessage } from "./format.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/**
 * End-to-end coverage for the deep-agent discovery map + selector
 * hooks. The root thread reads the always-on projections; each
 * {@link SubagentCard} mounts scoped `useMessages` / `useToolCalls`
 * subscriptions keyed on the subagent's namespace.
 */
export function DeepAgentStream({
  apiUrl,
  assistantId = "deep_agent",
}: Props) {
  const thread = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
  });

  const subagents = [...thread.subagents.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}

      <div data-testid="root-message-count">{thread.messages.length}</div>
      <div data-testid="root-toolcall-count">{thread.toolCalls.length}</div>
      <div data-testid="root-toolcall-names">
        {thread.toolCalls.map((tc) => tc.name).join(",")}
      </div>

      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            [{msg.getType()}] {formatMessage(msg)}
          </div>
        ))}
      </div>

      <div data-testid="subagent-count">{subagents.length}</div>
      <div data-testid="subagent-names">
        {subagents.map((sub) => sub.name).join(",")}
      </div>

      {subagents.map((sub) => (
        <SubagentCard key={sub.id} stream={thread} subagent={sub} />
      ))}

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Run analysis")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

interface SubagentCardProps {
  stream: ReturnType<
    typeof useStream<{ messages: BaseMessage[] }>
  >;
  subagent: SubagentDiscoverySnapshot;
}

function SubagentCard({ stream, subagent }: SubagentCardProps) {
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);

  const testId = `subagent-${subagent.name}`;
  const namespaceKey = subagent.namespace.join("/");


  return (
    <div data-testid={testId}>
      <div data-testid={`${testId}-status`}>{subagent.status}</div>
      <div data-testid={`${testId}-namespace`}>{namespaceKey}</div>
      <div data-testid={`${testId}-messages-count`}>{messages.length}</div>
      <div data-testid={`${testId}-toolcalls-count`}>{toolCalls.length}</div>
      <div data-testid={`${testId}-toolcall-names`}>
        {toolCalls.map((tc) => tc.name).join(",")}
      </div>
      <div data-testid={`${testId}-messages`}>
        {messages.map((msg, i) => (
          <span
            key={msg.id ?? i}
            data-testid={`${testId}-message-${i}`}
          >
            [{msg.getType()}] {formatMessage(msg)}
          </span>
        ))}
      </div>
    </div>
  );
}
