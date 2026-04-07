import type { CSSProperties, FormEvent } from "react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import type { Message } from "@langchain/langgraph-sdk";

export interface TraceEntry {
  id: string;
  kind: string;
  label: string;
  detail: string;
  timestamp: string;
  raw: unknown;
}

export interface SubagentCardData {
  id: string;
  title: string;
  status: string;
  messageCount: number;
  preview?: string;
}

interface ProtocolPlaygroundProps {
  title: string;
  description: string;
  assistantId: string;
  apiUrl: string;
  threadId: string | null;
  protocolLabel: string;
  placeholder: string;
  suggestions: string[];
  messages: Message[];
  isLoading: boolean;
  error?: unknown;
  values?: unknown;
  metadata?: unknown;
  eventLog: TraceEntry[];
  subagents?: SubagentCardData[];
  onSubmit: (content: string) => void;
  getMessageMetadata?: (message: Message) => unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const safeStringify = (value: unknown) => {
  if (value == null) return "No data yet.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const jsonViewTheme = {
  ...darkTheme,
  backgroundColor: "transparent",
  fontSize: "0.84rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} satisfies CSSProperties;

const getTextContent = (message: Message) => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");
};

const getReasoningContent = (message: Message) => {
  if (!Array.isArray(message.content)) return "";

  const reasoning: string[] = [];
  for (const block of message.content) {
    const maybeBlock = block as unknown;
    if (!isRecord(maybeBlock)) continue;
    if (
      maybeBlock["type"] === "reasoning" &&
      typeof maybeBlock["reasoning"] === "string"
    ) {
      reasoning.push(maybeBlock["reasoning"]);
    }
  }

  return reasoning.join("");
};

const getToolCallSummary = (message: Message) => {
  if (!("tool_calls" in message) || !Array.isArray(message.tool_calls)) return "";
  if (message.tool_calls.length === 0) return "";
  return `Requested ${message.tool_calls.length} tool call${
    message.tool_calls.length === 1 ? "" : "s"
  }.`;
};

const getMessageLabel = (type: Message["type"]) => {
  switch (type) {
    case "human":
      return "User";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return "Assistant";
  }
};

const getMetadataBadge = (metadata: unknown) => {
  if (!isRecord(metadata)) return "";
  const streamMetadata = isRecord(metadata.streamMetadata)
    ? metadata.streamMetadata
    : undefined;
  const node =
    typeof streamMetadata?.langgraph_node === "string"
      ? streamMetadata.langgraph_node
      : undefined;
  const namespace =
    typeof streamMetadata?.langgraph_checkpoint_ns === "string"
      ? streamMetadata.langgraph_checkpoint_ns
      : undefined;

  if (node != null && namespace != null) return `${node} · ${namespace}`;
  if (node != null) return node;
  if (namespace != null) return namespace;
  return "";
};

function Composer({
  placeholder,
  onSubmit,
  disabled,
}: {
  placeholder: string;
  onSubmit: (content: string) => void;
  disabled: boolean;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const content = String(data.get("content") ?? "");
    if (!content.trim()) return;
    form.reset();
    onSubmit(content);
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        name="content"
        rows={3}
        disabled={disabled}
        placeholder={placeholder}
        className="composer-textarea"
        onKeyDown={(event) => {
          const target = event.currentTarget;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            target.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">Enter to send, Shift+Enter for a new line.</span>
        <button className="primary-button" disabled={disabled} type="submit">
          {disabled ? "Streaming..." : "Send"}
        </button>
      </div>
    </form>
  );
}

function MessageFeed({
  messages,
  getMessageMetadata,
}: {
  messages: Message[];
  getMessageMetadata?: (message: Message) => unknown;
}) {
  if (messages.length === 0) {
    return (
      <div className="empty-feed">
        <h3>No messages yet</h3>
        <p>
          Start a run to inspect how this agent behaves over the new protocol.
        </p>
      </div>
    );
  }

  return (
    <div className="message-feed">
      {messages.map((message, index) => {
        const text = getTextContent(message);
        const reasoning = getReasoningContent(message);
        const toolSummary = getToolCallSummary(message);
        const metadata = getMessageMetadata?.(message);
        const badge = getMetadataBadge(metadata);
        const content =
          text || reasoning || toolSummary || safeStringify(message.content);

        return (
          <article key={message.id ?? `${message.type}-${index}`} className="message-card">
            <div className="message-card-header">
              <span className="message-role">{getMessageLabel(message.type)}</span>
              {badge ? <span className="message-badge">{badge}</span> : null}
            </div>
            {reasoning ? (
              <div className="reasoning-block">
                <div className="reasoning-label">Reasoning</div>
                <div>{reasoning}</div>
              </div>
            ) : null}
            <div className="message-content">{content}</div>
          </article>
        );
      })}
    </div>
  );
}

function JsonPanel({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  const isTreeValue = typeof value === "object" && value !== null;

  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>{title}</h3>
      </div>
      {value == null ? (
        <div className="empty-panel">No data yet.</div>
      ) : isTreeValue ? (
        <div className="json-panel">
          <JsonView
            collapsed={2}
            displayDataTypes={false}
            displayObjectSize={false}
            enableClipboard={false}
            shortenTextAfterLength={80}
            style={jsonViewTheme}
            value={value}
          />
        </div>
      ) : (
        <pre className="json-panel">{safeStringify(value)}</pre>
      )}
    </section>
  );
}

function EventLog({ eventLog }: { eventLog: TraceEntry[] }) {
  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>Recent Events</h3>
      </div>
      {eventLog.length === 0 ? (
        <div className="empty-panel">Tool and update events will appear here.</div>
      ) : (
        <div className="trace-list">
          {eventLog.map((entry) => (
            <details key={entry.id} className="trace-item">
              <summary>
                <span className="trace-kind">{entry.kind}</span>
                <span className="trace-label">{entry.label}</span>
                <span className="trace-time">{entry.timestamp}</span>
              </summary>
              <div className="trace-detail">{entry.detail}</div>
              <pre className="trace-raw">{safeStringify(entry.raw)}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function SubagentPanel({ subagents }: { subagents: SubagentCardData[] }) {
  if (subagents.length === 0) return null;

  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>Subagents</h3>
      </div>
      <div className="subagent-list">
        {subagents.map((subagent) => (
          <article key={subagent.id} className="subagent-card">
            <div className="subagent-header">
              <strong>{subagent.title}</strong>
              <span className={`status-pill status-${subagent.status.toLowerCase()}`}>
                {subagent.status}
              </span>
            </div>
            <div className="subagent-meta">
              {subagent.messageCount} streamed message{subagent.messageCount === 1 ? "" : "s"}
            </div>
            {subagent.preview ? (
              <div className="subagent-preview">{subagent.preview}</div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export function ProtocolPlayground({
  title,
  description,
  assistantId,
  apiUrl,
  threadId,
  protocolLabel,
  placeholder,
  suggestions,
  messages,
  isLoading,
  error,
  values,
  metadata,
  eventLog,
  subagents = [],
  onSubmit,
  getMessageMetadata,
}: ProtocolPlaygroundProps) {
  return (
    <section className="playground-shell">
      <header className="hero-card">
        <div>
          <div className="eyebrow">Protocol testbed</div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <dl className="hero-metadata">
          <div>
            <dt>Assistant</dt>
            <dd>{assistantId}</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd>{apiUrl}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{protocolLabel}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd>{threadId ?? "pending"}</dd>
          </div>
        </dl>
      </header>

      {error != null ? (
        <div className="error-banner">
          {error instanceof Error ? error.message : "An unexpected error occurred."}
        </div>
      ) : null}

      <div className="suggestion-row">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-chip"
            onClick={() => onSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Conversation</h3>
            <span className="conversation-status">
              {isLoading ? "Streaming response..." : "Idle"}
            </span>
          </div>
          <MessageFeed
            getMessageMetadata={getMessageMetadata}
            messages={messages}
          />
          <Composer
            disabled={isLoading}
            onSubmit={onSubmit}
            placeholder={placeholder}
          />
        </section>

        <aside className="sidebar-stack">
          <SubagentPanel subagents={subagents} />
          <JsonPanel title="Current State" value={values} />
          <JsonPanel title="Last Assistant Metadata" value={metadata} />
          <EventLog eventLog={eventLog} />
        </aside>
      </div>
    </section>
  );
}
