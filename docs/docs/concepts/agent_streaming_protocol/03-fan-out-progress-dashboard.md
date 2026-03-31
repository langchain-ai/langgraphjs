# Scenario 3: Fan-Out Progress Dashboard

## Description

A market research supervisor spawns 50 research subagents in parallel, each
investigating a different company. Each subagent runs independently: calling
search tools, reading documents, and producing a summary. The frontend
displays a live dashboard showing:

- Total agent count (spawned / running / completed / failed)
- Per-agent status badges with progress indicators
- Expanding any agent shows its live token stream
- Aggregate cost tracker across all agents
- Ability to cancel individual runaway agents

This scenario validates the protocol at high fan-out: hundreds of
concurrent namespace streams, lifecycle tracking, dynamic subscription
management, and server-side filtering as a performance requirement.

## Agent Setup

```typescript
import { StateGraph, Annotation, Send } from "@langchain/langgraph";

const ResearchState = Annotation.Root({
  companies: Annotation<string[]>,
  results: Annotation<CompanyReport[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});

async function supervisor(state: typeof ResearchState.State) {
  return state.companies.map(
    (company) => new Send("researcher", { company })
  );
}

async function researcher(state: { company: string }, config) {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini" });
  const tools = [searchTool, readDocumentTool];
  const agent = createReactAgent({ llm, tools });

  const result = await agent.invoke(
    { messages: [{ role: "user", content: `Research ${state.company}` }] },
    config
  );

  return { results: [{ company: state.company, summary: extractSummary(result) }] };
}

const graph = new StateGraph(ResearchState)
  .addNode("supervisor", supervisor)
  .addNode("researcher", researcher)
  .addEdge("__start__", "supervisor")
  .addEdge("researcher", "__end__")
  .compile();
```

## v1: Current Approach

```typescript
// v1: stream with subgraphs to see all researcher activity
const allEvents = [];
for await (const chunk of await graph.stream(
  { companies: fiftyCompanies },
  { streamMode: ["updates", "messages"], subgraphs: true }
)) {
  const [namespace, mode, data] = chunk;
  allEvents.push({ namespace, mode, data });

  // Problem: we receive EVERY token from EVERY researcher.
  // 50 agents × ~500 tokens each = ~25,000 message events.
  // All arrive on one stream. Client must:
  // 1. Parse every namespace to determine which agent
  // 2. Maintain a local map of agent → status (no lifecycle events)
  // 3. Render all 50 agent views simultaneously
  // 4. No way to expand/collapse — all data is always delivered
}
```

**Problems with v1**:

1. **No lifecycle tracking**: The client has no `spawned` / `completed` /
   `failed` events. It must infer agent status by watching for first/last
   events from each namespace — fragile and race-prone.

2. **All events, all the time**: 50 agents × ~500 tokens = ~25,000 events.
   Every event is serialized, transmitted, and parsed even though the
   dashboard only needs status counts for most agents (user is viewing
   details of maybe 1-2 at a time).

3. **No server-side filtering**: Can't say "give me lifecycle events for
   all agents but message tokens for only the one I'm inspecting." It's
   all-or-nothing per mode.

4. **No cost tracking**: No way to see how much each subagent is spending
   without custom instrumentation.

5. **No tree view**: Must manually build the agent hierarchy by parsing
   namespace segments.

## v2: Protocol Approach

### In-Process

```typescript
import { createSession } from "@langchain/langgraph/protocol";

const session = createSession(graph, {
  input: { companies: fiftyCompanies },
});

// 1. Subscribe to lifecycle GLOBALLY — see all agent spawn/complete/fail
const lifecycle = session.subscribe("lifecycle");

// 2. Subscribe to usage GLOBALLY — aggregate cost tracking
const usage = session.subscribe("usage");

// 3. Get the initial tree
const tree = await session.agent.getTree();

// Track state
const agents = new Map<string, AgentStatus>();
let totalCost = 0;

// Process lifecycle events — this is ~100 events total (50 spawn + 50 complete)
// not 25,000 token events
(async () => {
  for await (const event of lifecycle) {
    const ns = event.params.namespace.join("/");
    agents.set(ns, event.params.data);

    updateDashboard({
      total: agents.size,
      running: [...agents.values()].filter(a => a.event === "running").length,
      completed: [...agents.values()].filter(a => a.event === "completed").length,
      failed: [...agents.values()].filter(a => a.event === "failed").length,
    });
  }
})();

// Process usage events — per-LLM-call cost tracking
(async () => {
  for await (const event of usage) {
    totalCost += event.params.data.costUsd ?? 0;
    updateCostDisplay(totalCost, event.params.data);
  }
})();

// When user clicks on a specific agent to inspect it:
function expandAgent(namespace: string[]) {
  // DYNAMICALLY subscribe to that agent's messages — only now do we
  // receive its tokens. Server-side filtering means zero cost until
  // the user actually wants to see it.
  const agentMessages = session.subscribe("messages", {
    namespaces: [namespace],
  });

  (async () => {
    for await (const event of agentMessages) {
      renderAgentDetail(namespace, event.params.data);
    }
  })();
}

// When user collapses an agent — stop receiving its tokens
function collapseAgent(subscriptionId: string) {
  session.unsubscribe(subscriptionId);
}
```

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

function ResearchDashboard() {
  const transport = useRef(
    new ProtocolStreamTransport({ url: "ws://localhost:2024/v2/runs" })
  ).current;

  const thread = useStream({
    transport,
    assistantId: "research-supervisor",
  });

  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<string[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const activeSub = useRef<string | null>(null);

  // Subscribe to lifecycle + usage globally
  useEffect(() => {
    const lifecycleSub = transport.subscribe("lifecycle");
    const usageSub = transport.subscribe("usage");

    (async () => {
      for await (const event of lifecycleSub) {
        const ns = event.params.namespace.join("/");
        setAgents(prev => new Map(prev).set(ns, event.params.data));
      }
    })();

    (async () => {
      for await (const event of usageSub) {
        setTotalCost(prev => prev + (event.params.data.costUsd ?? 0));
      }
    })();

    return () => { lifecycleSub.unsubscribe(); usageSub.unsubscribe(); };
  }, [transport]);

  // Dynamic subscription when user expands an agent
  const onExpand = useCallback(async (namespace: string[]) => {
    // Unsubscribe from previous expanded agent
    if (activeSub.current) transport.unsubscribe(activeSub.current);

    setExpandedAgent(namespace.join("/"));
    setExpandedMessages([]);

    const sub = await transport.subscribe("messages", { namespaces: [namespace] });
    activeSub.current = sub.id;

    for await (const event of sub) {
      setExpandedMessages(prev => [...prev, event.params.data.message.content]);
    }
  }, [transport]);

  return (
    <div className="dashboard">
      {/* Summary bar */}
      <StatusBar
        total={agents.size}
        running={[...agents.values()].filter(a => a.event === "running").length}
        completed={[...agents.values()].filter(a => a.event === "completed").length}
        failed={[...agents.values()].filter(a => a.event === "failed").length}
        cost={totalCost}
      />

      {/* Agent grid — shows status badges for all agents */}
      <div className="agent-grid">
        {[...agents.entries()].map(([ns, info]) => (
          <AgentCard
            key={ns}
            namespace={ns}
            status={info.event}
            onClick={() => onExpand(ns.split("/"))}
            isExpanded={expandedAgent === ns}
          />
        ))}
      </div>

      {/* Expanded agent detail — shows live token stream */}
      {expandedAgent && (
        <AgentDetail
          namespace={expandedAgent}
          messages={expandedMessages}
          onCollapse={() => {
            if (activeSub.current) transport.unsubscribe(activeSub.current);
            setExpandedAgent(null);
          }}
        />
      )}
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **Poorly.**

v1 can stream from 50 subagents with `subgraphs: true`, but the experience
degrades significantly:

| Aspect | v1 | v2 |
|--------|----|----|
| **Events received** | ~25,000 (all tokens from all agents) | ~100 lifecycle + ~500 tokens from 1 expanded agent |
| **Wire traffic** | ~12 MB (all tokens serialized) | ~50 KB lifecycle + ~250 KB for expanded agent |
| **Agent status** | Must infer from event patterns | Explicit `lifecycle` events |
| **Cost tracking** | Not available | `usage` channel with per-call data |
| **Dynamic drill-down** | Not possible — all events always delivered | Subscribe on click, unsubscribe on collapse |
| **Agent tree** | Must build manually from namespace parsing | `agent.getTree()` command |
| **Server-side filtering** | None | Yes — server only sends subscribed events |

### What does v2 enable?

The key insight: at 50 agents, the dashboard needs **lifecycle events from
all agents** (O(N) events) but **message tokens from only 1 agent** (O(1)
streams). v1 forces O(N) token streams regardless. v2's subscription model
makes this O(1) + O(N_lifecycle) — a 50x reduction in data for the common
case where the user is watching the overview.

At 500 agents, the difference becomes 250x. At high fan-out, server-side
subscription filtering isn't a nice-to-have — it's a performance
requirement.

### Verdict

This scenario is the **primary motivation** for the protocol. v1 cannot
handle it at scale. v2's lifecycle channel, dynamic subscriptions,
server-side filtering, and usage tracking are all essential for a usable
fan-out dashboard.
