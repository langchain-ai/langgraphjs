# Subagents and subgraphs

`useStream` lists the subagents and subgraphs a thread's runs start, at no extra cost. To show what one of them says, pass it to a [selector hook](./selectors.md): its events stream only while a component that shows it is mounted.

## Table of contents

- [Snapshots](#snapshots)
- [Showing a subagent](#showing-a-subagent)
- [How a panel streams](#how-a-panel-streams)
- [Subgraphs](#subgraphs)
- [Related](#related)

## Snapshots

`stream.subagents` maps the id of each `task` tool call that started a subagent to a snapshot:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string; // the `task` tool call's id
  readonly name: string; // the subagent type, such as "researcher"
  readonly namespace: readonly string[];
  readonly parentId: string | null; // the subagent that started it, or null
  readonly depth: number; // 1 when the main agent started it
  readonly status: "running" | "complete" | "error";
  readonly taskInput: string | undefined; // the task it was given
  readonly output: unknown; // its result as text, once complete
  readonly error: string | undefined;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}
```

`stream.subgraphs` maps each subgraph's id to a snapshot, and `stream.subgraphsByNode` groups them by the graph node that started them:

```ts
interface SubgraphDiscoverySnapshot {
  readonly id: string;
  readonly namespace: readonly string[];
  readonly nodeName: string; // the node, as named in addNode(name, ...)
  readonly status: "running" | "complete" | "error";
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}
```

The snapshots carry no messages or values. Read those with the selector hooks.

## Showing a subagent

```tsx
import {
  useMessages,
  useToolCalls,
  useValues,
  type AnyStream,
  type SubagentDiscoverySnapshot,
} from "@langchain/react";

function Researchers({ stream }: { stream: AnyStream }) {
  const researchers = [...stream.subagents.values()].filter(
    (subagent) => subagent.name === "researcher"
  );

  return researchers.map((subagent) => (
    <SubagentCard key={subagent.id} stream={stream} subagent={subagent} />
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
        {subagent.name}: {subagent.status}
      </header>
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
    </section>
  );
}
```

## How a panel streams

- **On Agent Server 0.19 or later**, the run's own stream carries the main conversation and the subagents' status, and the open panels of a run share one more connection that carries only their subagents. A subagent nobody shows costs nothing.
- **On an older server**, the run streams every event of every subagent, and the panels read from it. A warning in the browser console says so once.
- **After a reload**, a subagent's `namespace` is the one its `task` tool message records, or `["tools:<tool call id>"]` until the first hook on it finds the real one with one small history read. The hook then streams it as above. A subagent that finished shows its messages from the thread's history. If its namespace can't be found, its hooks return nothing, and its snapshot still has its status and output.

## Subgraphs

Subgraphs work the same way. `subgraphsByNode` helps lay out nested graphs:

```tsx
import {
  useValues,
  type AnyStream,
  type SubgraphDiscoverySnapshot,
} from "@langchain/react";

function NestedGraphView({ stream }: { stream: AnyStream }) {
  return [...stream.subgraphsByNode].map(([nodeName, subgraphs]) => (
    <div key={nodeName}>
      <h3>{nodeName}</h3>
      {subgraphs.map((subgraph) => (
        <SubgraphCard key={subgraph.id} stream={stream} subgraph={subgraph} />
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

A subgraph shows once a run streams its events, so after a reload `subgraphs` starts empty and fills as runs stream. A subgraph's panel shows all its messages, also those it shares with its parent. A subagent's panel leaves out the main conversation's messages, which a deep agents subagent with `mode="fork"` starts from.

## Related

- [Selector hooks](./selectors.md)
- [Type safety](./type-safety.md)
