import { useState } from "react";
import type { ToolEvent } from "@langchain/langgraph-sdk";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { useStream } from "../../index.js";
import { getLocationTool } from "../fixtures/browser-fixtures.js";

interface Props {
  apiUrl: string;
  /** Override the default execute function for error-path testing. */
  execute?: Parameters<typeof getLocationTool.implement>[0];
}

export function HeadlessToolStream({ apiUrl, execute }: Props) {
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);

  const tool = getLocationTool.implement(
    execute ??
      (async () => ({
        latitude: 37.7749,
        longitude: -122.4194,
      })),
  );

  const { messages, isLoading, submit } = useStream<{ messages: BaseMessage[] }>({
    assistantId: "headlessToolAgent",
    apiUrl,
    tools: [tool],
    onTool: (event) => {
      setToolEvents((prev) => [...prev, event]);
    },
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
        {messages.length > 0 && (
          <div data-testid="message-last">
            {(() => {
              const last = messages[messages.length - 1];
              return typeof last.content === "string"
                ? last.content
                : JSON.stringify(last.content);
            })()}
          </div>
        )}
      </div>

      <div data-testid="loading">{isLoading ? "loading" : "idle"}</div>

      <div data-testid="tool-events">
        {toolEvents.map((event, i) => (
          <div key={i} data-testid={`tool-event-${i}`}>
            {`${event.phase}:${event.name}`}
            {event.phase === "error" && `:${event.error?.message}`}
          </div>
        ))}
      </div>

      <button
        data-testid="submit"
        onClick={() =>
          void submit({
            messages: [new HumanMessage("Where am I?")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
