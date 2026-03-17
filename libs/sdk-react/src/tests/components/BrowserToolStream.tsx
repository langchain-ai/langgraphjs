import { useState } from "react";
import type {
  Message,
  BrowserTool,
  BrowserToolEvent,
} from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  /** Override the default execute function for error-path testing. */
  execute?: BrowserTool["execute"];
}

/**
 * A minimal browser tool — defined inline so the test component has no
 * dependency on `langchain`. The execute function runs in the browser when
 * useStream detects a matching interrupt.
 */
function makeGetLocationTool(
  execute: BrowserTool["execute"],
): BrowserTool<
  { highAccuracy?: boolean },
  { latitude: number; longitude: number }
> {
  return {
    name: "get_location",
    execute: execute as BrowserTool<
      { highAccuracy?: boolean },
      { latitude: number; longitude: number }
    >["execute"],
  };
}

export function BrowserToolStream({ apiUrl, execute }: Props) {
  const [toolEvents, setToolEvents] = useState<BrowserToolEvent[]>([]);

  const defaultExecute: BrowserTool["execute"] = async (_args) => ({
    latitude: 37.7749,
    longitude: -122.4194,
  });

  const { messages, isLoading, submit } = useStream<{ messages: Message[] }>({
    assistantId: "browserToolAgent",
    apiUrl,
    browserTools: [makeGetLocationTool(execute ?? defaultExecute)],
    onBrowserTool: (event) => {
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
            messages: [{ type: "human", content: "Where am I?" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
