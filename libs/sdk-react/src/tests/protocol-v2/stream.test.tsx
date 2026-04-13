import { useRef } from "react";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";
import { describe, expect, inject, it } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactAgent } from "langchain";
import type { DeepAgent } from "deepagents";

import { useStream } from "../../index.js";

type ProtocolStreamMode = "v2-sse" | "v2-websocket";

const protocolV2ServerUrl = inject("protocolV2ServerUrl");
const streamProtocols = ["v2-sse"] as const;

describe("protocol v2 browser streaming", () => {
  it("streams stategraph message events from the protocol-v2 server", async () => {
    await runAcrossProtocols(async (streamProtocol) => {
      const screen = await render(
        <ProtocolStategraphStream
          apiUrl={protocolV2ServerUrl}
          streamProtocol={streamProtocol}
        />,
      );

      try {
        await screen.getByTestId("submit").click();

        await expect
          .element(screen.getByTestId("loading"))
          .toHaveTextContent("Loading...");
        await expect
          .element(screen.getByTestId("message-count"))
          .toHaveTextContent("2");
        await expect
          .element(screen.getByTestId("message-0"))
          .toHaveTextContent("Summarize the protocol draft.");
        await expect
          .element(screen.getByTestId("message-1"))
          .toHaveTextContent("Plan accepted.");
      } finally {
        cleanupRender(screen);
      }
    });
  });

  it("streams createAgent tool calls and final messages from the protocol-v2 server", async () => {
    await runAcrossProtocols(async (streamProtocol) => {
      const screen = await render(
        <ProtocolCreateAgentStream
          apiUrl={protocolV2ServerUrl}
          streamProtocol={streamProtocol}
        />,
      );

      try {
        await screen.getByTestId("submit").click();

        await expect
          .element(screen.getByTestId("loading"))
          .toHaveTextContent("Loading...");
        await expect
          .element(screen.getByTestId("toolcall-count"))
          .toHaveTextContent("1");
        await expect
          .element(screen.getByTestId("toolcall-names"))
          .toHaveTextContent("get_weather");
        await expect
          .element(screen.getByTestId("toolcall-result"))
          .toHaveTextContent("San Francisco");
        await expect
          .element(screen.getByTestId("toolcall-result"))
          .toHaveTextContent("Foggy");
        await expect
          .element(screen.getByTestId("observed-toolcall-states"))
          .toHaveTextContent("get_weather:pending");
        await expect
          .element(screen.getByTestId("observed-toolcall-states"))
          .toHaveTextContent("get_weather:completed");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("What is the weather in San Francisco?");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("tool_call:get_weather");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("tool_result:");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("It's 64F and foggy in San Francisco.");
      } finally {
        cleanupRender(screen);
      }
    });
  });

  it("streams createDeepAgent subagents, subagent messages, and subagent tool calls from the protocol-v2 server", async () => {
    await runAcrossProtocols(async (streamProtocol) => {
      const screen = await render(
        <ProtocolDeepAgentStream
          apiUrl={protocolV2ServerUrl}
          streamProtocol={streamProtocol}
        />,
      );

      try {
        await screen.getByTestId("submit").click();

        await expect
          .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
          .toHaveTextContent("2");
        await expect
          .element(screen.getByTestId("subagent-researcher-task-description"))
          .toHaveTextContent("Search the web for protocol risks");
        await expect
          .element(screen.getByTestId("subagent-data-analyst-task-description"))
          .toHaveTextContent("Inspect the sample dataset");
        await expect
          .element(screen.getByTestId("subagent-researcher-result"))
          .toHaveTextContent(
            "Research completed: reconnect and lifecycle handling need coverage.",
          );
        await expect
          .element(screen.getByTestId("subagent-data-analyst-result"))
          .toHaveTextContent("Analysis completed: found 2 sample records.");
        await expect
          .element(screen.getByTestId("subagent-researcher-messages-count"))
          .not.toHaveTextContent("0");
        await expect
          .element(screen.getByTestId("subagent-data-analyst-messages-count"))
          .not.toHaveTextContent("0");
        await expect
          .element(screen.getByTestId("subagent-researcher-toolcalls-count"))
          .toHaveTextContent("1");
        await expect
          .element(screen.getByTestId("subagent-data-analyst-toolcalls-count"))
          .toHaveTextContent("1");
        await expect
          .element(screen.getByTestId("subagent-researcher-toolcall-names"))
          .toHaveTextContent("search_web");
        await expect
          .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
          .toHaveTextContent("query_database");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent(
            "Research protocol risks and inspect the sample dataset.",
          );
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("tool_call:task");
        await expect
          .element(screen.getByTestId("messages"))
          .toHaveTextContent("Both subagents completed their tasks successfully.");
      } finally {
        cleanupRender(screen);
      }
    });
  });
});

async function runAcrossProtocols(
  callback: (streamProtocol: ProtocolStreamMode) => Promise<void>,
) {
  for (const streamProtocol of streamProtocols) {
    await callback(streamProtocol);
  }
}

function cleanupRender(screen: unknown) {
  const withUnmount = screen as { unmount?: () => void };
  withUnmount.unmount?.();
  document.body.innerHTML = "";
}

function ProtocolStategraphStream({
  apiUrl,
  streamProtocol,
}: {
  apiUrl: string;
  streamProtocol: ProtocolStreamMode;
}) {
  const thread = useStream<{ messages: Message[] }>({
    assistantId: "stategraph_text",
    apiUrl,
    streamProtocol,
  });

  return (
    <div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <div data-testid="messages">
        {thread.messages.map((message, index) => (
          <div key={message.id ?? index} data-testid={`message-${index}`}>
            {formatMessage(message)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [
              {
                content: "Summarize the protocol draft.",
                type: "human",
              },
            ],
          })
        }
      >
        Submit
      </button>
    </div>
  );
}

function ProtocolCreateAgentStream({
  apiUrl,
  streamProtocol,
}: {
  apiUrl: string;
  streamProtocol: ProtocolStreamMode;
}) {
  const thread = useStream<ReactAgent>({
    assistantId: "create_agent",
    apiUrl,
    streamProtocol,
  });
  const observedToolCallStatesRef = useRef(new Set<string>());

  for (const toolCall of thread.toolCalls) {
    observedToolCallStatesRef.current.add(
      `${toolCall.call.name}:${toolCall.state}`,
    );
  }

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((message, index) => (
          <div key={message.id ?? index} data-testid={`message-${index}`}>
            {formatMessage(message)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="toolcall-count">{thread.toolCalls.length}</div>
      <div data-testid="toolcall-names">
        {thread.toolCalls.map((toolCall) => toolCall.call.name).join(",")}
      </div>
      <div data-testid="toolcall-result">
        {thread.toolCalls.map((toolCall) => formatUnknown(toolCall.result)).join(",")}
      </div>
      <div data-testid="observed-toolcall-states">
        {[...observedToolCallStatesRef.current].sort().join(",")}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [
              {
                content: "What is the weather in San Francisco?",
                type: "human",
              },
            ],
          })
        }
      >
        Submit
      </button>
    </div>
  );
}

function ProtocolDeepAgentStream({
  apiUrl,
  streamProtocol,
}: {
  apiUrl: string;
  streamProtocol: ProtocolStreamMode;
}) {
  const thread = useStream<DeepAgent>({
    assistantId: "deep_agent",
    apiUrl,
    streamProtocol,
    filterSubagentMessages: true,
  });
  const observedSubagentToolCallStatesRef = useRef(new Set<string>());

  const subagents = [...thread.subagents.values()].sort((a, b) => {
    const typeA = String(a.toolCall?.args?.subagent_type ?? "");
    const typeB = String(b.toolCall?.args?.subagent_type ?? "");
    return typeA.localeCompare(typeB);
  });

  for (const subagent of subagents) {
    const subagentType = String(subagent.toolCall?.args?.subagent_type ?? "unknown");
    for (const toolCall of subagent.toolCalls) {
      observedSubagentToolCallStatesRef.current.add(
        `${subagentType}:${toolCall.call.name}:${toolCall.state}`,
      );
    }
  }

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((message, index) => (
          <div key={message.id ?? index} data-testid={`message-${index}`}>
            {formatMessage(message)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="subagent-count">{subagents.length}</div>
      {subagents.map((subagent) => {
        const subagentType = String(
          subagent.toolCall?.args?.subagent_type ?? "unknown",
        );

        return (
          <div key={subagent.id} data-testid={`subagent-${subagentType}`}>
            <div data-testid={`subagent-${subagentType}-status`}>
              {subagent.status}
            </div>
            <div data-testid={`subagent-${subagentType}-task-description`}>
              {String(subagent.toolCall?.args?.description ?? "")}
            </div>
            <div data-testid={`subagent-${subagentType}-result`}>
              {String(subagent.result ?? "")}
            </div>
            <div data-testid={`subagent-${subagentType}-messages-count`}>
              {subagent.messages.length}
            </div>
            <div data-testid={`subagent-${subagentType}-toolcalls-count`}>
              {subagent.toolCalls.length}
            </div>
            <div data-testid={`subagent-${subagentType}-toolcall-names`}>
              {subagent.toolCalls.map((toolCall) => toolCall.call.name).join(",")}
            </div>
          </div>
        );
      })}
      <div data-testid="observed-subagent-toolcall-states">
        {[...observedSubagentToolCallStatesRef.current].sort().join(",")}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            {
              messages: [
                {
                  content: "Research protocol risks and inspect the sample dataset.",
                  type: "human",
                },
              ],
            },
            { streamSubgraphs: true },
          )
        }
      >
        Submit
      </button>
    </div>
  );
}

function formatMessage(message: BaseMessage): string {
  if (
    AIMessage.isInstance(message) &&
    "tool_calls" in message &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    return message.tool_calls
      .map((toolCall) => `tool_call:${toolCall.name}:${JSON.stringify(toolCall.args)}`)
      .join(",");
  }

  if (ToolMessage.isInstance(message)) {
    return `tool_result:${formatUnknown(message.content)}`;
  }

  return formatUnknown(message.content);
}

function formatUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
