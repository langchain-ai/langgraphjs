import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type {
  SubgraphDiscoverySnapshot,
} from "@langchain/langgraph-sdk/stream";

import {
  useStream,
  useMessages,
} from "../../index.js";
import { formatMessage } from "./format.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  transport?: "sse" | "websocket";
}

/**
 * Exercises `stream.subgraphs` / `stream.subgraphsByNode` — discovery
 * maps populated when the graph runs a child subgraph. Each rendered
 * `SubgraphPanel` mounts a namespace-scoped `useMessages` subscription
 * to prove selectors flow through namespaced subgraphs the same way
 * they do for subagents.
 */
export function SubgraphDiscoveryStream({
  apiUrl,
  assistantId = "subgraph_graph",
  transport,
}: Props) {
  const thread = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
    transport,
  });

  const subgraphs = [...thread.subgraphs.values()];
  const subgraphsByNodeEntries = [...thread.subgraphsByNode.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="root-message-count">{thread.messages.length}</div>
      <div data-testid="subgraph-count">{subgraphs.length}</div>
      <div data-testid="subgraph-nodes">
        {subgraphsByNodeEntries
          .map(([node, arr]) => `${node}:${arr.length}`)
          .join(",")}
      </div>

      {subgraphs.map((sg, i) => (
        <SubgraphPanel key={sg.id ?? i} stream={thread} subgraph={sg} />
      ))}

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Call subgraph please")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

interface SubgraphPanelProps {
  stream: ReturnType<
    typeof useStream<{ messages: BaseMessage[] }>
  >;
  subgraph: SubgraphDiscoverySnapshot;
}

function SubgraphPanel({ stream, subgraph }: SubgraphPanelProps) {
  const messages = useMessages(stream, subgraph);
  const nsKey = subgraph.namespace.join("/") || "root";

  return (
    <div data-testid={`subgraph-${nsKey}`}>
      <div data-testid={`subgraph-${nsKey}-namespace`}>{nsKey}</div>
      <div data-testid="scoped-subgraph-messages-count">{messages.length}</div>
      <div data-testid={`subgraph-${nsKey}-messages-count`}>
        {messages.length}
      </div>
      <div data-testid={`subgraph-${nsKey}-messages`}>
        {messages.map((msg, i) => (
          <span
            key={msg.id ?? i}
            data-testid={`subgraph-${nsKey}-message-${i}`}
          >
            {formatMessage(msg)}
          </span>
        ))}
      </div>
    </div>
  );
}
