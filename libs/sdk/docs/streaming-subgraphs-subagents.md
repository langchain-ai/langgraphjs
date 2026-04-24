# Subgraphs & subagents

Complex agents often delegate work to **subgraphs** (nested graphs
compiled into the parent) or spin up dynamic **subagents** (deep-agent
style task workers). `ThreadStream` exposes three projections that let
you observe this tree in real time:

| Getter                      | Use when                                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `thread.subgraphs`          | Discover every static subgraph that starts under the root.              |
| `thread.triggeredSubgraphs` | Discover subgraphs whose start was caused by a tool call / send / edge. |
| `thread.subagents`          | *deepagents-specific.* Discover `task`-tool subagents.                  |

All three are lazy, shared buffers — multiple `for await` loops can
consume them independently, and late consumers replay previously
emitted handles.

## `thread.subgraphs`

Each element is a `SubgraphHandle` with the same namespace-scoped
projection surface as `ThreadStream`:

```ts
interface SubgraphHandle {
  readonly name: string;
  readonly index: number;
  readonly namespace: string[];
  readonly graphName?: string;
  readonly cause?: LifecycleCause;

  readonly messages: AsyncIterable<StreamingMessage>;
  readonly values: AsyncIterable<unknown> & PromiseLike<unknown>;
  readonly output: Promise<unknown>;
  readonly toolCalls: AsyncIterable<AssembledToolCall>;
  readonly subgraphs: AsyncIterable<SubgraphHandle>;  // nested
  readonly audio: AsyncIterable<AudioMedia>;
  readonly images: AsyncIterable<ImageMedia>;
  readonly video: AsyncIterable<VideoMedia>;
  readonly files: AsyncIterable<FileMedia>;

  subscribe(channels, options?): Promise<SubscriptionHandle<...>>;
}
```

### Example

```ts
const thread = client.threads.stream({ assistantId: "research-pipeline" });

await thread.run.input({
  input: {
    messages: [{ role: "user", content: "Research TypeScript 5.8." }],
  },
});

for await (const sub of thread.subgraphs) {
  console.log(`→ subgraph ${sub.name} [${sub.namespace.join("/")}]`);

  // Fan out: consume each subgraph's messages in parallel.
  void (async () => {
    for await (const msg of sub.messages) {
      process.stdout.write(`[${sub.name}] `);
      for await (const token of msg.text) process.stdout.write(token);
      process.stdout.write("\n");
    }
  })();

  const output = await sub.output;
  console.log(`✓ subgraph ${sub.name} finished:`, output);
}

await thread.close();
```

### Nested subgraphs

`sub.subgraphs` yields children of `sub`'s namespace. The recursion is
fully lazy — only subgraphs whose handle you touch open a subscription.

## `thread.triggeredSubgraphs`

Every `lifecycle: started` event can carry a `cause` tag describing
why it started. `triggeredSubgraphs` filters discovery to subgraphs
that have a non-empty `cause`:

```ts
for await (const sub of thread.triggeredSubgraphs) {
  switch (sub.cause?.type) {
    case "toolCall":
      console.log(
        `tool-triggered subgraph ${sub.name} (tool_call_id=${sub.cause.tool_call_id})`
      );
      console.log("corresponding tool-started:", sub.toolStartedEvent);
      break;
    case "send":
      console.log(`send-triggered subgraph ${sub.name}`);
      break;
    case "edge":
      console.log(`edge-triggered subgraph ${sub.name}`);
      break;
    default:
      console.log(`other-triggered subgraph ${sub.name}`);
  }
}
```

Use this iterator when you need to correlate subgraph starts with the
specific tool call or send that produced them — for example to render
UI cards for dynamic worker spawns.

`TriggeredSubgraphHandle` extends `SubgraphHandle` with two extra
fields:

| Field                  | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `cause`                | Non-null `LifecycleCause` — always present on this iterator.     |
| `toolStartedEvent`     | The correlated `tool-started` event when `cause.type === "toolCall"`. |

## `thread.subagents` *(deepagents-only)*

> **Deprecation notice.** `thread.subagents` is a thin convenience over
> `thread.triggeredSubgraphs` that hard-codes deepagents' "the subagent
> is a `task` tool call" convention. Prefer `triggeredSubgraphs` for
> generic code; `subagents` is scheduled for removal in a future major.

It yields `SubagentHandle`s — a subset of `SubgraphHandle` with extra
promises for the task lifecycle:

```ts
interface SubagentHandle {
  readonly name: string;
  readonly callId: string;
  readonly namespace: string[];
  readonly taskInput: Promise<string>;
  readonly output: Promise<unknown>;

  readonly messages: AsyncIterable<StreamingMessage>;
  readonly toolCalls: AsyncIterable<AssembledToolCall>;
  readonly subgraphs: AsyncIterable<SubgraphHandle>;
  // + media + subscribe()
}
```

### Example

```ts
const thread = client.threads.stream({ assistantId: "deep-agent" });

await thread.run.input({
  input: { messages: [{ role: "user", content: "Write a haiku about the sea" }] },
});

for await (const sub of thread.subagents) {
  console.log(`\n--- Subagent ${sub.name} (call ${sub.callId}) ---`);
  console.log("task:", await sub.taskInput);

  void (async () => {
    for await (const msg of sub.messages) {
      const text = await msg.text;
      console.log(`  [${sub.name}] ${text.slice(0, 80)}`);
    }
  })();

  void (async () => {
    for await (const tc of sub.toolCalls) {
      console.log(
        `  [${sub.name}] ${tc.name} → ${await tc.status}`
      );
    }
  })();

  const out = await sub.output;
  console.log(`✓ subagent ${sub.name} finished:`, out);
}
```

## Subscribing to the subgraph namespace

For advanced cases, `sub.subscribe(...)` opens a raw subscription
automatically scoped to the subgraph's namespace:

```ts
const debug = await sub.subscribe(["lifecycle", "tools"], { depth: 2 });
for await (const event of debug) {
  console.log(event.method, event.params.data);
}
```

This is the same contract as `thread.subscribe(...)` — see
[Advanced streaming](./streaming-advanced.md).
