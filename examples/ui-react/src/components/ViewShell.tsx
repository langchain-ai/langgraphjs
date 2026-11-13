import type { ReactNode } from "react";

import { API_URL } from "../api";

/**
 * Common hero header used by every agent view. Keeps the metadata
 * grid consistent while each view owns its own grid content below.
 */
export function ViewShell({
  assistantId,
  threadId,
  title,
  description,
  error,
  children,
}: {
  assistantId: string;
  threadId: string | null;
  title: string;
  description: ReactNode;
  error?: unknown;
  children: ReactNode;
}) {
  return (
    <section className="playground-shell">
      <header className="hero-card">
        <div>
          <div className="eyebrow">useStream · live</div>
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
            <dd>{API_URL}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd>{threadId ?? "pending"}</dd>
          </div>
        </dl>
      </header>

      {error != null ? (
        <div className="error-banner">
          {error instanceof Error
            ? error.message
            : "An unexpected error occurred."}
        </div>
      ) : null}

      {children}
    </section>
  );
}
