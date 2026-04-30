import { useCallback, useEffect, useState } from "react";
import { useStream } from "@langchain/react";
import type { ToolEvent } from "@langchain/langgraph-sdk";

import type { agent as headlessAgentType } from "../agents/headless-tools";
import { API_URL, type Transport } from "../api";
import {
  Composer,
  JsonPanel,
  MessageFeed,
  RecentEvents,
  ViewShell,
} from "../components";
import {
  listMemories,
  type MemoryRecord,
  toolImplementations,
} from "../tools/implementation";
import { safeStringify } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "headless-tools";

const SUGGESTIONS = [
  "Remember that I prefer concise technical answers tagged as preference.",
  "What do you remember about me?",
  "Where am I right now?",
  "Forget memories tagged preference.",
];

export function HeadlessToolsView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);

  const stream = useStream<typeof headlessAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
    tools: toolImplementations,
    onTool: (event) => {
      setToolEvents((current) => [event, ...current].slice(0, 12));
      void refreshMemories();
    },
  });

  const eventTrace = useEventTrace(stream);

  async function refreshMemories() {
    if (typeof indexedDB === "undefined") return;
    try {
      setMemories(await listMemories());
    } catch {
      setMemories([]);
    }
  }

  useEffect(() => {
    void refreshMemories();
  }, []);

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  const statusLabel = stream.isLoading ? "Streaming..." : "Idle";

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Headless Tools"
      description={
        <>
          Schema-only tools run in the browser. Memory stays in IndexedDB, tool
          lifecycle events are reported through <code>onTool</code>, and
          headless tool interrupts are auto-resumed by the React hook without
          surfacing as user-facing interrupts.
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
            <h3>Memory assistant</h3>
            <span className="conversation-status">{statusLabel}</span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={stream.messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Ask the assistant to remember, recall, search, forget, or use location."
          />
        </section>

        <aside className="sidebar-stack">
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Browser Memory</h3>
              <button
                className="secondary-button"
                onClick={() => void refreshMemories()}
                type="button"
              >
                Refresh
              </button>
            </div>
            <div className="memory-list">
              {memories.length === 0 ? (
                <div className="empty-panel">
                  No browser memories yet. Ask the agent to remember something.
                </div>
              ) : (
                memories.map((memory) => (
                  <article className="memory-card" key={memory.key}>
                    <div className="memory-card-header">
                      <strong>{memory.key}</strong>
                      <span>{memory.tags.join(", ") || "untagged"}</span>
                    </div>
                    <pre>{safeStringify(memory.value)}</pre>
                  </article>
                ))
              )}
            </div>
          </section>
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Headless Tool Events</h3>
              <span>{toolEvents.length} recent</span>
            </div>
            <div className="tool-event-list">
              {toolEvents.length === 0 ? (
                <div className="empty-panel">
                  Client-side tool events appear here as tools execute.
                </div>
              ) : (
                toolEvents.map((event, index) => (
                  <div className="tool-event-row" key={`${event.name}-${index}`}>
                    <span className={`status-pill status-${event.phase}`}>
                      {event.phase}
                    </span>
                    <strong>{event.name}</strong>
                    <small>
                      {event.duration != null ? `${event.duration}ms` : "pending"}
                    </small>
                  </div>
                ))
              )}
            </div>
          </section>
          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}
