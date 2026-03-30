# Scenario 7: Cost-Controlled Research Fleet

## Description

A research platform runs weekly analysis jobs where a supervisor spawns
30-100 subagents to investigate different aspects of a topic. Each
subagent runs autonomously — calling LLMs, searching the web, reading
documents. The platform operator needs:

- Real-time cost visibility across all agents
- Per-agent budget caps that automatically pause runaway agents
- The ability to inspect a paused agent's state and decide to resume
  with a higher budget or cancel it
- A final cost report broken down by agent and model

This scenario validates the `usage` module and its interaction with
`lifecycle` and `state`.

## v1: Current Approach

```typescript
// v1: No built-in cost tracking. Must use external instrumentation.

// Option A: LangSmith traces — but data arrives asynchronously,
// minutes after the run, not in real-time.

// Option B: Custom callback handler that counts tokens
class CostTracker extends BaseCallbackHandler {
  totalCost = 0;

  async handleLLMEnd(output, runId) {
    const usage = output.llmOutput?.tokenUsage;
    if (usage) {
      this.totalCost += estimateCost(usage);
    }
  }
}

const tracker = new CostTracker();
for await (const chunk of await graph.stream(input, {
  callbacks: [tracker],
  streamMode: ["updates"],
  subgraphs: true,
})) {
  // Can check tracker.totalCost periodically, but:
  // - No per-agent breakdown
  // - No automatic budget enforcement
  // - No real-time streaming of cost to frontend
  // - Must build custom solution for everything
}
```

**Problems with v1**:

1. **No real-time cost streaming**: Cost data is only available via
   callbacks on the server. No mechanism to stream it to the frontend.

2. **No per-agent cost breakdown**: The callback handler sees all LLM
   calls but doesn't know which subagent produced them without
   parsing metadata.

3. **No budget enforcement**: No way to automatically pause an agent
   when it exceeds a cost threshold. Must build custom logic that
   monitors the callback and cancels the subgraph run.

4. **No resume-after-budget**: If a budget-paused agent has useful
   partial results, there's no mechanism to increase its budget and
   resume — it must be restarted from scratch.

## v2: Protocol Approach

### In-Process

```typescript
import { createSession } from "@langchain/langgraph/protocol";

const session = createSession(graph, {
  input: { topic: "AI regulation landscape 2026", depth: "comprehensive" },
});

// Set global budget for the entire run
await session.usage.setBudget({ maxCostUsd: 10.0, action: "pause" });

// Subscribe to lifecycle + usage globally
const lifecycle = session.subscribe("lifecycle");
const usage = session.subscribe("usage");

const agentCosts = new Map<string, number>();

// Track per-agent costs in real time
(async () => {
  for await (const event of usage) {
    if (event.method === "usage.llmCall") {
      const ns = event.params.namespace.join("/");
      const current = agentCosts.get(ns) ?? 0;
      agentCosts.set(ns, current + (event.params.data.costUsd ?? 0));

      renderCostDashboard({
        total: [...agentCosts.values()].reduce((a, b) => a + b, 0),
        byAgent: Object.fromEntries(agentCosts),
        lastCall: event.params.data,
      });
    }

    if (event.method === "usage.summary") {
      renderCostSummary(event.params.data);
    }
  }
})();

// Track agent lifecycle — detect budget-paused agents
(async () => {
  for await (const event of lifecycle) {
    if (event.params.data.event === "interrupted") {
      // Agent was paused by budget enforcement
      const ns = event.params.namespace;

      // Inspect its partial results
      const state = await session.state.get(ns);
      console.log(`Agent ${ns.join("/")} paused at $${agentCosts.get(ns.join("/"))}`);
      console.log(`Partial results:`, state.result.values);

      // Decision: increase budget and resume, or cancel
      const partialValue = assessPartialResults(state.result.values);
      if (partialValue > 0.5) {
        await session.usage.setBudget({
          namespace: ns,
          maxCostUsd: 2.0,  // Give it $2 more
          action: "pause",
        });
        // Agent automatically resumes
      }
    }
  }
})();
```

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useEffect, useRef, useState } from "react";

function ResearchCostDashboard() {
  const transport = useRef(
    new ProtocolStreamTransport({ url: "ws://localhost:2024/v2/runs" })
  ).current;

  const thread = useStream({ transport, assistantId: "research-fleet" });

  const [costs, setCosts] = useState({ total: 0, byAgent: {}, byModel: {} });
  const [pausedAgents, setPausedAgents] = useState<PausedAgent[]>([]);

  useEffect(() => {
    // Set initial budget
    transport.usage.setBudget({ maxCostUsd: 10.0, action: "pause" });

    const usageSub = transport.subscribe("usage");
    const lifecycleSub = transport.subscribe("lifecycle");

    (async () => {
      for await (const event of usageSub) {
        if (event.method === "usage.llmCall") {
          setCosts(prev => ({
            total: prev.total + (event.params.data.costUsd ?? 0),
            byAgent: {
              ...prev.byAgent,
              [event.params.namespace.join("/")]:
                (prev.byAgent[event.params.namespace.join("/")] ?? 0) +
                (event.params.data.costUsd ?? 0),
            },
            byModel: {
              ...prev.byModel,
              [event.params.data.model]:
                (prev.byModel[event.params.data.model] ?? 0) +
                (event.params.data.costUsd ?? 0),
            },
          }));
        }
      }
    })();

    (async () => {
      for await (const event of lifecycleSub) {
        if (event.params.data.event === "interrupted") {
          setPausedAgents(prev => [...prev, {
            namespace: event.params.namespace,
            cost: costs.byAgent[event.params.namespace.join("/")] ?? 0,
          }]);
        }
      }
    })();

    return () => { usageSub.unsubscribe(); lifecycleSub.unsubscribe(); };
  }, [transport]);

  const handleResume = async (namespace: string[], additionalBudget: number) => {
    await transport.usage.setBudget({
      namespace,
      maxCostUsd: additionalBudget,
      action: "pause",
    });
    setPausedAgents(prev => prev.filter(a => a.namespace !== namespace));
  };

  return (
    <div className="cost-dashboard">
      {/* Real-time cost gauges */}
      <CostGauge total={costs.total} budget={10.0} />

      {/* Per-model breakdown */}
      <ModelCostTable costs={costs.byModel} />

      {/* Per-agent cost bars */}
      <AgentCostBars costs={costs.byAgent} />

      {/* Paused agents requiring intervention */}
      {pausedAgents.map((agent) => (
        <PausedAgentCard
          key={agent.namespace.join("/")}
          agent={agent}
          onResume={(budget) => handleResume(agent.namespace, budget)}
          onCancel={() => {/* cancel agent */}}
        />
      ))}
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **No.**

v1 has no cost tracking mechanism. Building this with v1 requires:
- Custom callback handlers (server-side only, not streamable)
- Custom budget enforcement logic
- Custom API endpoints to stream cost data to the frontend
- Custom pause/resume orchestration
- Essentially building a bespoke system that duplicates much of what
  the v2 protocol provides

### What does v2 enable?

| Capability | v1 | v2 |
|------------|----|----|
| **Real-time cost streaming** | Not available | `usage.llmCall` events per call |
| **Per-agent cost breakdown** | Requires custom parsing | Namespace on every usage event |
| **Per-model breakdown** | Requires custom callback | `model` field on `usage.llmCall` |
| **Budget enforcement** | Must build custom | `usage.setBudget` command |
| **Budget-pause notification** | Must build custom | `lifecycle.interrupted` event |
| **Inspect paused agent** | Separate API | `state.get` command in-band |
| **Resume with higher budget** | Must restart agent | `usage.setBudget` on namespace |
| **Cost summary** | Must aggregate manually | `usage.summary` events |

### Verdict

Cost control at scale is **not possible with v1**. The `usage` module is a
new capability with no v1 equivalent. For production deployments running
hundreds of agents with real LLM costs, this is a critical feature.
