import { useEffect, useState } from "react";

import {
  ProtocolSwitcher,
  type PlaygroundTransportMode,
} from "./components/ProtocolSwitcher";
import { CreateAgentView } from "./views/CreateAgentView";
import { DeepAgentView } from "./views/DeepAgentView";
import { API_URL } from "./views/shared";
import { StateGraphView } from "./views/StateGraphView";

type TabId = "stategraph" | "create-agent" | "deep-agent";

const DEFAULT_TAB: TabId = "stategraph";
const DEFAULT_TRANSPORT: PlaygroundTransportMode = "legacy";

const TABS: Array<{
  id: TabId;
  title: string;
  blurb: string;
}> = [
  {
    id: "stategraph",
    title: "StateGraph",
    blurb: "Basic graph loop with explicit tool routing.",
  },
  {
    id: "create-agent",
    title: "createAgent",
    blurb: "Single-agent runtime using the LangChain helper.",
  },
  {
    id: "deep-agent",
    title: "Deep Agent",
    blurb: "Coordinator plus three protocol-focused subagents.",
  },
];

const isTabId = (value: string | null): value is TabId =>
  value === "stategraph" ||
  value === "create-agent" ||
  value === "deep-agent";

const isTransportMode = (
  value: string | null
): value is PlaygroundTransportMode =>
  value === "legacy" || value === "http-sse" || value === "websocket";

const getUrlSelection = () => {
  if (typeof window === "undefined") {
    return {
      activeTab: DEFAULT_TAB,
      transportMode: DEFAULT_TRANSPORT,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent");
  const transport = params.get("transport");

  return {
    activeTab: isTabId(agent) ? agent : DEFAULT_TAB,
    transportMode: isTransportMode(transport)
      ? transport
      : DEFAULT_TRANSPORT,
  };
};

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>(
    () => getUrlSelection().activeTab
  );
  const [transportMode, setTransportMode] = useState<PlaygroundTransportMode>(
    () => getUrlSelection().transportMode
  );
  const activeViewKey = `${activeTab}:${transportMode}`;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    url.searchParams.set("agent", activeTab);
    url.searchParams.set("transport", transportMode);
    window.history.replaceState({}, "", url);
  }, [activeTab, transportMode]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">LangGraph protocol playground</div>
          <h1>New Protocol Testbed</h1>
          <p className="app-subtitle">
            Compare a StateGraph, a createAgent runtime, and a Deep Agent while
            the frontend streams through the standard legacy API, the new
            session-based HTTP+SSE protocol, or the new WebSocket protocol.
          </p>
        </div>
        <div className="header-badges">
          <span className="header-badge">API: {API_URL}</span>
          <ProtocolSwitcher
            transportMode={transportMode}
            onChange={setTransportMode}
          />
        </div>
      </header>

      <nav className="tab-row" aria-label="Protocol example views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? "tab-button-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            <small>{tab.blurb}</small>
          </button>
        ))}
      </nav>

      {activeTab === "stategraph" ? (
        <StateGraphView key={activeViewKey} transportMode={transportMode} />
      ) : null}
      {activeTab === "create-agent" ? (
        <CreateAgentView key={activeViewKey} transportMode={transportMode} />
      ) : null}
      {activeTab === "deep-agent" ? (
        <DeepAgentView key={activeViewKey} transportMode={transportMode} />
      ) : null}
    </main>
  );
}
