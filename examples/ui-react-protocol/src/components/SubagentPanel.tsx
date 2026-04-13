import type { SubagentCardData } from "./ProtocolPlayground.types";

interface SubagentPanelProps {
  subagents: SubagentCardData[];
}

export function SubagentPanel({ subagents }: SubagentPanelProps) {
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
              {subagent.messageCount} streamed message
              {subagent.messageCount === 1 ? "" : "s"}
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
