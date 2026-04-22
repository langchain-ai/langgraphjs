import { useEffect, useState } from "react";

import { API_URL, isTransport, type Transport } from "./api";
import { TransportToggle } from "./components/TransportToggle";
import { CustomChannelView } from "./views/CustomChannelView";
import { DeepAgentView } from "./views/DeepAgentView";
import { FanOutView } from "./views/FanOutView";
import { HumanInTheLoopView } from "./views/HumanInTheLoopView";
import { NestedStateGraphView } from "./views/NestedStateGraphView";
import { ReactAgentView } from "./views/ReactAgentView";

type TabId =
  | "nested-stategraph"
  | "react-agent"
  | "deep-agent"
  | "human-in-the-loop"
  | "fan-out"
  | "custom-channel";

const TABS: Array<{ id: TabId; title: string; blurb: string }> = [
  {
    id: "nested-stategraph",
    title: "Nested StateGraph",
    blurb: "Top-level graph with two compiled subgraphs rendered live.",
  },
  {
    id: "react-agent",
    title: "ReAct Agent",
    blurb: "createAgent runtime with streaming tool calls.",
  },
  {
    id: "deep-agent",
    title: "Deep Agent",
    blurb: "Four poetry subagents running in parallel.",
  },
  {
    id: "human-in-the-loop",
    title: "Human in the Loop",
    blurb: "Approve, edit, or reject a sensitive tool call.",
  },
  {
    id: "fan-out",
    title: "Fan-out (100+)",
    blurb: "Hundred+ subagents; content streams load lazily.",
  },
  {
    id: "custom-channel",
    title: "Custom Stream Channel",
    blurb:
      "Server-side transformer; view reads only custom:timeline — no messages/values.",
  },
];

const DEFAULT_TAB: TabId = "nested-stategraph";
const DEFAULT_TRANSPORT: Transport = "sse";

const isTabId = (value: string | null): value is TabId =>
  TABS.some((tab) => tab.id === value);

function getUrlSelection(): { tab: TabId; transport: Transport } {
  if (typeof window === "undefined") {
    return { tab: DEFAULT_TAB, transport: DEFAULT_TRANSPORT };
  }
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("agent");
  const transport = params.get("transport");
  return {
    tab: isTabId(tab) ? tab : DEFAULT_TAB,
    transport: isTransport(transport) ? transport : DEFAULT_TRANSPORT,
  };
}

export function App() {
  const initial = getUrlSelection();
  const [activeTab, setActiveTab] = useState<TabId>(initial.tab);
  const [transport, setTransport] = useState<Transport>(initial.transport);

  // Remount the active view on tab or transport change — each view owns a
  // `useStreamExperimental` call and we want a fresh thread when the user
  // flips a switch rather than replaying the previous thread on the new
  // transport.
  const viewKey = `${activeTab}:${transport}`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("agent", activeTab);
    url.searchParams.set("transport", transport);
    window.history.replaceState({}, "", url);
  }, [activeTab, transport]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">useStreamExperimental showcase</div>
          <h1>Streaming Hooks Playground</h1>
          <p className="app-subtitle">
            Six agent shapes driven by the new{" "}
            <code>useStreamExperimental</code> hook and its selector
            companions (<code>useMessages</code>, <code>useToolCalls</code>,{" "}
            <code>useValues</code>, <code>useChannel</code>). Flip between the
            HTTP+SSE and WebSocket transports to see that the React surface
            does not change.
          </p>
        </div>
        <div className="header-badges">
          <span className="header-badge">API: {API_URL}</span>
          <TransportToggle transport={transport} onChange={setTransport} />
        </div>
      </header>

      <nav className="tab-row" aria-label="Agent views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${
              activeTab === tab.id ? "tab-button-active" : ""
            }`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            <small>{tab.blurb}</small>
          </button>
        ))}
      </nav>

      {renderView(activeTab, viewKey, transport)}
    </main>
  );
}

function renderView(tab: TabId, key: string, transport: Transport) {
  switch (tab) {
    case "nested-stategraph":
      return <NestedStateGraphView key={key} transport={transport} />;
    case "react-agent":
      return <ReactAgentView key={key} transport={transport} />;
    case "deep-agent":
      return <DeepAgentView key={key} transport={transport} />;
    case "human-in-the-loop":
      return <HumanInTheLoopView key={key} transport={transport} />;
    case "fan-out":
      return <FanOutView key={key} transport={transport} />;
    case "custom-channel":
      return <CustomChannelView key={key} transport={transport} />;
    default:
      return null;
  }
}
