# Scenario 6: Reconnection Mid-Run

## Description

A user is watching a long-running agent execution on their laptop. The
agent has been running for 10 minutes with 5 active subagents. The user
closes their laptop lid (connection drops), reopens it 30 seconds later,
and the frontend should seamlessly resume showing the agent's progress
without losing context or requiring a page refresh.

This scenario validates the protocol's reconnection mechanism, event
buffer replay, and subscription restoration.

## v1: Current Approach

```typescript
// v1: SSE with client-side retry
const stream = client.runs.stream(threadId, assistantId, {
  streamMode: ["messages", "updates"],
  streamSubgraphs: true,
  streamResumable: true,  // Server-side resumable stream
});

// If connection drops, streamWithRetry in the SDK retries
// using Last-Event-ID header. But:
for await (const event of stream) {
  renderEvent(event);
}

// If the retry window is exceeded or the SSE connection was not
// resumable, the client must:
// 1. Fetch current thread state via GET /threads/:id/state
// 2. Rebuild the UI from scratch
// 3. Start a new stream (which may miss events that occurred during disconnect)
```

**Problems with v1**:

1. **SSE retry is transport-level, not protocol-level**: The `Last-Event-ID`
   mechanism depends on the server buffering SSE events. If the server
   didn't set event IDs, or if the buffer expired, reconnection fails
   silently — the client starts receiving events from "now" and misses
   everything that happened during disconnect.

2. **No subscription restoration**: If the client had filtered events
   (not possible in v1 anyway), there's no mechanism to restore those
   filters on reconnect.

3. **No state snapshot on reconnect**: The reconnected stream doesn't
   tell the client what the current agent tree looks like. The client
   must make a separate `getState` call.

4. **UI rebuild**: After a failed reconnect, the frontend typically shows
   a "connection lost" error and requires a page refresh or manual
   "reconnect" button click. The user loses their scroll position,
   expanded panels, and UI state.

## v2: Protocol Approach

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useEffect, useRef, useState } from "react";

function ResilientDashboard() {
  const transportRef = useRef<ProtocolStreamTransport | null>(null);
  const [connected, setConnected] = useState(true);
  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const subscriptionIds = useRef<string[]>([]);

  // Create transport with reconnection handlers
  useEffect(() => {
    const transport = new ProtocolStreamTransport({
      url: "ws://localhost:2024/v2/runs",
      runId: "run_abc123",

      onDisconnect: () => {
        setConnected(false);
        // UI shows "Reconnecting..." banner but doesn't tear down state
      },

      onReconnect: async (client) => {
        // Protocol-level reconnect: restore subscriptions + replay missed events
        const result = await client.sendCommand("subscription.reconnect", {
          runId: "run_abc123",
          lastEventId: transport.lastEventId, // Tracked automatically
          subscriptions: subscriptionIds.current,
        });

        if (result.restored) {
          // Server replayed missed events — they flow through existing
          // subscription handlers automatically
          setConnected(true);

          // Update agent tree from reconnect response
          for (const ns of result.currentNamespaces) {
            setAgents(prev => new Map(prev).set(
              ns.namespace.join("/"), ns
            ));
          }
        } else {
          // Buffer overflow — too many events missed. Request full state.
          const tree = await client.agent.getTree();
          rebuildFromTree(tree);
          setConnected(true);
        }
      },
    });

    transportRef.current = transport;

    // Set up subscriptions
    const lifecycleSub = transport.subscribe("lifecycle");
    subscriptionIds.current.push(lifecycleSub.id);

    (async () => {
      for await (const event of lifecycleSub) {
        setAgents(prev => new Map(prev).set(
          event.params.namespace.join("/"),
          event.params.data
        ));
      }
    })();

    return () => transport.close();
  }, []);

  return (
    <div>
      {!connected && (
        <Banner type="warning">Reconnecting...</Banner>
      )}
      <AgentDashboard agents={agents} />
    </div>
  );
}
```

### Reconnection Sequence

```
  Client                        Server
    │                              │
    │◄──── events flowing ────────►│
    │                              │
    ╳ connection drops (laptop lid) ╳
    │                              │
    │ (30 seconds pass)            │ (continues running, buffering events)
    │                              │
    │──── WebSocket reconnect ────►│
    │                              │
    │──── subscription.reconnect ─►│
    │      { lastEventId: "42",    │
    │        subscriptions: [...] }│
    │                              │
    │◄─── { restored: true,   ────│  Server replays events 43-67
    │       missedEvents: 25,      │  from its event buffer
    │       currentNamespaces: [   │
    │         { ns: ["a1"],        │
    │           status: "running" }│
    │       ]}                     │
    │                              │
    │◄──── replayed events ───────│  Events 43-67 flow through
    │      (25 events)             │  existing subscription handlers
    │                              │
    │◄──── live events resume ────│  Event 68+
    │                              │
```

## Protocol Analysis

### Can v1 handle this? **Partially.**

v1's `streamWithRetry` + `Last-Event-ID` provides basic SSE-level reconnection.
`streamResumable: true` enables server-side event buffering. But:

| Aspect | v1 | v2 |
|--------|----|----|
| **Reconnect mechanism** | SSE `Last-Event-ID` (transport-level) | `subscription.reconnect` (protocol-level) |
| **Subscription restore** | N/A (no subscriptions) | Subscriptions restored by ID |
| **State on reconnect** | Separate `getState` call needed | `currentNamespaces` in reconnect response |
| **Buffer overflow** | Silent — client misses events with no warning | Explicit `restored: false` + `agent.getTree` fallback |
| **UI continuity** | Often requires page refresh | Seamless — UI state preserved, missed events replayed |

### Verdict

v1's reconnection is transport-level and fragile. v2's protocol-level
reconnection with explicit subscription restoration, state snapshots, and
buffer overflow signaling provides a robust experience for long-running
agent sessions.
