# Subgraphs

Complex agents often delegate work to **subgraphs** (nested graphs
compiled into the parent). `ThreadStream` exposes `thread.subgraphs`
so you can observe this tree in real time:

| Getter                      | Use when                                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `thread.subgraphs`          | Discover every subgraph that starts under the root.                     |

It is a lazy, shared buffer — multiple `for await` loops can consume it
independently, and late consumers replay previously emitted handles.

For deepagents-specific `task`-tool subagents, see
[Subagents](./streaming-subagents.md).

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
  toolStartedEvent?: ToolsEvent;

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

await thread.run.start({
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

### Cause metadata

Every `lifecycle: started` event can carry a `cause` tag describing
why it started. `thread.subgraphs` yields both caused and uncaused
subgraphs; inspect `sub.cause` when you need to correlate dynamic
starts with the tool call, send, or edge that produced them:

```ts
for await (const sub of thread.subgraphs) {
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

Use these fields when you need to render dynamic worker spawns or
correlate a subgraph with the operation that produced it:

| Field              | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `cause`            | Optional `LifecycleCause` from the subgraph's `lifecycle.started` event.  |
| `toolStartedEvent` | The correlated `tool-started` event when `cause.type === "toolCall"`.     |
