import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";
import { describe, expect, inject, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStreamExperimental } from "../index.js";

const protocolV2ServerUrl = inject("protocolV2ServerUrl");

describe("useStreamExperimental — protocol v2 browser streaming", () => {
  it("submit() projects values.messages into the snapshot", async () => {
    const screen = await render(
      <ExperimentalStategraphStream apiUrl={protocolV2ServerUrl} />,
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
      await expect
        .element(screen.getByTestId("loading"))
        .toHaveTextContent("Not loading");
    } finally {
      cleanupRender(screen);
    }
  });

  it("surfaces interrupts and resumes via submit({ command: { resume } })", async () => {
    const screen = await render(
      <ExperimentalInterruptStream apiUrl={protocolV2ServerUrl} />,
    );

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("interrupt-prompt"))
        .toHaveTextContent("Approve the outbound action?");

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("0");
      await expect
        .element(screen.getByTestId("completed"))
        .toHaveTextContent("true");
    } finally {
      cleanupRender(screen);
    }
  });
});

function cleanupRender(screen: unknown) {
  const withUnmount = screen as { unmount?: () => void };
  withUnmount.unmount?.();
  document.body.innerHTML = "";
}

function ExperimentalStategraphStream({ apiUrl }: { apiUrl: string }) {
  const thread = useStreamExperimental<{ messages: Message[] }>({
    assistantId: "stategraph_text",
    apiUrl,
  });

  return (
    <div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <div data-testid="messages">
        {thread.messages.map((message, index) => (
          <div key={message.id ?? index} data-testid={`message-${index}`}>
            {formatMessage(message as unknown as BaseMessage)}
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

function ExperimentalInterruptStream({ apiUrl }: { apiUrl: string }) {
  const thread = useStreamExperimental<{
    request: string;
    decision: Record<string, unknown> | null;
    completed: boolean;
  }>({
    assistantId: "interrupt_graph",
    apiUrl,
  });

  const interruptPrompt =
    thread.interrupt != null &&
    typeof thread.interrupt.value === "object" &&
    thread.interrupt.value !== null
      ? String(
          (thread.interrupt.value as { prompt?: unknown }).prompt ?? "",
        )
      : "";

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-prompt">{interruptPrompt}</div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit({ request: "ship it" })}
      >
        Submit
      </button>
      <button
        data-testid="resume"
        onClick={() =>
          void thread.submit(undefined, {
            command: { resume: { approved: true } },
          })
        }
      >
        Resume
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
      .map(
        (toolCall) =>
          `tool_call:${toolCall.name}:${JSON.stringify(toolCall.args)}`,
      )
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
