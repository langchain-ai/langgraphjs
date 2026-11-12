import { useEffect, useState } from "react";

import { API_URL } from "./api";
import {
  CATEGORIES,
  DEFAULT_EXAMPLE_ID,
  EXAMPLES,
  getExample,
  getExamplesByCategory,
} from "./examples";
import langchainIcon from "./langchain-icon.svg";

function getUrlExampleId(): string {
  if (typeof window === "undefined") return DEFAULT_EXAMPLE_ID;
  const exampleId = new URLSearchParams(window.location.search).get("agent");
  return getExample(exampleId)?.id ?? DEFAULT_EXAMPLE_ID;
}

export function App() {
  const [activeExampleId, setActiveExampleId] = useState(getUrlExampleId);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeExample = getExample(activeExampleId) ?? EXAMPLES[0];
  const ActiveView = activeExample.component;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("agent", activeExample.id);
    window.history.replaceState({}, "", url);
  }, [activeExample.id]);

  return (
    <div className="app-frame">
      <Sidebar
        activeExampleId={activeExample.id}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => {
          setActiveExampleId(id);
          setSidebarOpen(false);
        }}
      />
      {sidebarOpen ? (
        <button
          aria-label="Close navigation"
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}

      <main className="app-main">
        <header className="app-header">
          <button
            aria-label="Open navigation"
            className="mobile-nav-button"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            Menu
          </button>
          <div>
            <div className="eyebrow">LangGraph streaming testbed</div>
            <h1>React streaming examples</h1>
            <p className="app-subtitle">
              Production-grade examples for the v2 React streaming surface:
              messages, tool calls, state values, headless tools, interrupts,
              subgraphs, and subagents.
            </p>
          </div>
          <div className="header-badges">
            <span className="header-badge">API: {API_URL}</span>
          </div>
        </header>

        <ActiveView key={activeExample.id} />
      </main>
    </div>
  );
}

function Sidebar({
  activeExampleId,
  isOpen,
  onClose,
  onSelect,
}: {
  activeExampleId: string;
  isOpen: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const groups = getExamplesByCategory();
  return (
    <aside className={`app-sidebar ${isOpen ? "app-sidebar-open" : ""}`}>
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">
          <img alt="" src={langchainIcon} />
        </div>
        <div>
          <div className="brand-title">langgraph</div>
          <div className="brand-subtitle">React Streaming Testbed</div>
        </div>
        <button
          aria-label="Close navigation"
          className="sidebar-close"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Streaming examples">
        {(Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>).map(
          (category) => {
            const examples = groups[category] ?? [];
            if (examples.length === 0) return null;
            return (
              <section className="sidebar-section" key={category}>
                <div className="sidebar-section-label">
                  {CATEGORIES[category].title}
                </div>
                <div className="sidebar-section-description">
                  {CATEGORIES[category].description}
                </div>
                <div className="sidebar-link-list">
                  {examples.map((example) => {
                    const isActive = example.id === activeExampleId;
                    return (
                      <button
                        className={`sidebar-link ${isActive ? "sidebar-link-active" : ""
                          }`}
                        key={example.id}
                        onClick={() => onSelect(example.id)}
                        type="button"
                      >
                        <span>{example.title}</span>
                        <small>{example.description}</small>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          }
        )}
      </nav>
    </aside>
  );
}
