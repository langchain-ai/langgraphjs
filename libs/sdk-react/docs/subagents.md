# Subagents & subgraphs

Subagents and subgraphs are discovered **eagerly** but streamed **lazily**. The root hook keeps cheap identity snapshots on `stream.subagents`, `stream.subgraphs`, and `stream.subgraphsByNode`. To render a subagent's content, pass its snapshot into a companion selector hook — the subscription is scoped to the subagent's namespace and reference-counted.

## Table of contents

- [Discovery snapshots](#discovery-snapshots)
- [Rendering subagent content](#rendering-subagent-content)
- [Subgraphs](#subgraphs)
- [Related](#related)

## Discovery snapshots

Subagent / subgraph identity is always available from the root:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string; // tool-call id that spawned it
  readonly name: string; // "researcher", "writer", …
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "pending" | "running" | "complete" | "error";
}
```

Subgraph snapshots carry the same metadata plus the producing node id:

```ts
interface SubgraphDiscoverySnapshot {
  readonly id: string;
  readonly namespace: readonly string[];
  readonly nodeId: string;
  readonly status: "pending" | "running" | "complete" | "error";
}
```

The root hook exposes three discovery maps:

- `stream.subagents: ReadonlyMap<string, SubagentDiscoverySnapshot>`
- `stream.subgraphs: ReadonlyMap<string, SubgraphDiscoverySnapshot>`
- `stream.subgraphsByNode: ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>`

They update live as the server emits discovery events, without opening per-subagent subscriptions.

## Rendering subagent content

Pass the snapshot as the `target` argument to any selector hook. Messages, tool calls, and values stream only for the subagents that are actively rendered:

```tsx
import {
  useStream,
  useMessages,
  useToolCalls,
  useValues,
  type AnyStream,
  type SubagentDiscoverySnapshot,
} from "@langchain/react";

function Researchers({ stream }: { stream: AnyStream }) {
  const researchers = [...stream.subagents.values()].filter(
    (s) => s.name === "researcher",
  );

  return researchers.map((s) => (
    <SubagentCard key={s.id} stream={stream} subagent={s} />
  ));
}

function SubagentCard({
  stream,
  subagent,
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);
  const values = useValues<ResearcherState>(stream, subagent);

  return (
    <section>
      <header>
        {subagent.name} — {subagent.status}
      </header>
      {messages.map((m) => (
        <Bubble key={m.id} msg={m} />
      ))}
    </section>
  );
}
```

Subscriptions open on mount and close when the last consumer for a given `(channel, namespace)` tuple unmounts. Components that don't render a subagent's content never pay for its wire traffic.

## Subgraphs

Subgraph snapshots work the same way. The `subgraphsByNode` map is handy for laying out nested-graph visualisations:

```tsx
function NestedGraphView({ stream }: { stream: AnyStream }) {
  return [...stream.subgraphsByNode].map(([nodeId, subgraphs]) => (
    <div key={nodeId}>
      <h3>{nodeId}</h3>
      {subgraphs.map((sg) => (
        <SubgraphCard key={sg.id} stream={stream} subgraph={sg} />
      ))}
    </div>
  ));
}

function SubgraphCard({
  stream,
  subgraph,
}: {
  stream: AnyStream;
  subgraph: SubgraphDiscoverySnapshot;
}) {
  const values = useValues(stream, subgraph);
  return <pre>{JSON.stringify(values, null, 2)}</pre>;
}
```

## Related

- [Companion selector hooks](./selectors.md)
- [Type safety — agent-brand inference](./type-safety.md)
