import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { useStream } from "@langchain/react";

import "./styles.css";
import { LocalStreamTransport } from "./transport";

type ChatState = {
  messages: Array<{ content: string; type: "human" }>;
};

function getMessageRole(type: string) {
  return type === "human" ? "You" : "Assistant";
}

function formatMessageContent(content: unknown) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

export function App() {
  const [content, setContent] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const transport = useMemo(() => new LocalStreamTransport("/api/stream"), []);
  const stream = useStream<ChatState>({
    transport,
  });
  const visibleMessages = useMemo(
    () => stream.messages.filter((message) => message != null),
    [stream.messages]
  );

  return (
    <main className={`chat-shell ${theme === "light" ? "light" : ""}`}>
      <button
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
        className="theme-toggle"
        type="button"
        onClick={() => setTheme((current) =>
          current === "dark" ? "light" : "dark"
        )}
      >
        {theme === "dark" ? (
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
              className="moon-shape"
              d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"
            />
          </svg>
        )}
      </button>

      <section className="hero-card">
        <div aria-label="React logo" className="framework-logo" role="img">
          <svg viewBox="-11.5 -10.23174 23 20.46348">
            <circle cx="0" cy="0" fill="#61dafb" r="2.05" />
            <g fill="none" stroke="#61dafb" strokeWidth="1">
              <ellipse rx="11" ry="4.2" />
              <ellipse rx="11" ry="4.2" transform="rotate(60)" />
              <ellipse rx="11" ry="4.2" transform="rotate(120)" />
            </g>
          </svg>
        </div>
        <div className="eyebrow">langgraph streaming</div>
        <div className="hero-copy">
          <h1>React Chat</h1>
          <p>
            A compact chat example powered by{" "}
            <code>@langchain/react</code> and a custom backend connected
            through a local transport adapter.
          </p>
        </div>
      </section>

      <section aria-label="Chat messages" className="chat-card">
        {visibleMessages.length === 0 ? (
          <div className="empty-state">
            Ask the agent about LangGraph streaming.
          </div>
        ) : null}

        {visibleMessages.map((message, index) => (
          <div
            className={`message ${message.type === "human" ? "user" : ""}`}
            key={message.id ?? index}
          >
            <span>{getMessageRole(message.type)}</span>
            <p>{formatMessageContent(message.content)}</p>
          </div>
        ))}

        {visibleMessages.length === 0 && !stream.isLoading && stream.error ? (
          <div className="error">
            Could not reach the custom stream backend. Check that{" "}
            <code>pnpm dev</code> is running, then try again.
          </div>
        ) : null}
      </section>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const nextContent = content.trim();
          if (nextContent.length === 0) return;

          setContent("");
          void stream.submit({
            messages: [{ content: nextContent, type: "human" }],
          });
        }}
      >
        <textarea
          aria-label="Message"
          name="content"
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            const target = e.target as HTMLTextAreaElement;

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              target.form?.requestSubmit();
            }
          }}
          placeholder="Ask a follow-up..."
          rows={3}
          value={content}
        />
        <button disabled={content.trim() === ""} type="submit">
          Send
        </button>
      </form>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
