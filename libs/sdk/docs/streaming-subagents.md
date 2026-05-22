# Subagents

## `thread.subagents` *(deepagents-only)*

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

await thread.run.start({
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

## Subscribing to the subagent namespace

For advanced cases, `sub.subscribe(...)` opens a raw subscription
automatically scoped to the subagent's namespace:

```ts
const debug = await sub.subscribe(["lifecycle", "tools"], { depth: 2 });
for await (const event of debug) {
  console.log(event.method, event.params.data);
}
```

This is the same contract as `thread.subscribe(...)` — see
[Advanced streaming](./streaming-advanced.md).
