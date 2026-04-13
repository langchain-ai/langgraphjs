import { Composer } from "./Composer";
import { EventLog } from "./EventLog";
import { JsonPanel } from "./JsonPanel";
import { MessageFeed } from "./MessageFeed";
import { SubagentPanel } from "./SubagentPanel";
import type { ProtocolPlaygroundProps } from "./ProtocolPlayground.types";

export type {
  ProtocolPlaygroundProps,
  SubagentCardData,
  TraceEntry,
} from "./ProtocolPlayground.types";

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
  conversationSupplement,
  composerDisabled,
  statusLabel,
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
              {statusLabel ?? (isLoading ? "Streaming response..." : "Idle")}
            </span>
          </div>
          <MessageFeed
            getMessageMetadata={getMessageMetadata}
            messages={messages}
          />
          {conversationSupplement}
          <Composer
            disabled={composerDisabled ?? isLoading}
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
