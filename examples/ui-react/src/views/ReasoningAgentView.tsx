import { useCallback, useMemo, useState } from "react";
import { useMessages, useStream } from "@langchain/react";

import type { agent as reasoningAgentType } from "../agents/reasoning-agent";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { getReasoningContent } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "reasoning-agent";

const SUGGESTIONS = [
  "Solve this logic puzzle: three switches control three bulbs in another room. You can enter once. How do you match them?",
  "Reason through whether a cache should be invalidated before or after a database write.",
  "A train travels 60 miles at 30 mph and returns at 60 mph. What is the average speed?",
];

export function ReasoningAgentView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const stream = useStream<typeof reasoningAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const messages = useMessages(stream);
  const eventTrace = useEventTrace(stream);
  const reasoningMessages = useMemo(
    () =>
      messages
        .map((message) => getReasoningContent(message))
        .filter((reasoning) => reasoning.trim().length > 0),
    [messages]
  );

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Reasoning Agent"
      description={
        <>
          A reasoning-oriented agent using the app's existing model stack. When
          the runtime emits reasoning content, <code>MessageFeed</code> renders
          it in a dedicated reasoning block; otherwise the prompt asks for a
          concise reasoning summary before the answer.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            className="suggestion-chip"
            key={suggestion}
            onClick={() => handleSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Reasoning trace</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Thinking..." : "Idle"}
            </span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Ask a math, logic, or architecture question."
          />
        </section>

        <aside className="sidebar-stack">
          <JsonPanel
            title="Reasoning Blocks"
            value={{
              count: reasoningMessages.length,
              reasoning: reasoningMessages,
            }}
          />
          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}
