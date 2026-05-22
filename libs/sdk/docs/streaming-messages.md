# Streaming messages

`thread.messages` is the top-level projection for chat-model output.
Each `for await` yields a `StreamingMessage` — a live handle over a
single message lifecycle from `message-start` to
`message-finish` / `error`.

```ts
for await (const message of thread.messages) {
  for await (const token of message.text) {
    process.stdout.write(token);
  }
}
```

## The `StreamingMessage` shape

`StreamingMessage` exposes both streaming and promise-like surfaces for
the common fields:

| Property           | Type                                         | Description                                                                                              |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `text`             | `AsyncIterable<string> & PromiseLike<string>` | Iterate for token-by-token deltas, or `await` for the full concatenated text after the message finishes. |
| `reasoning`        | `AsyncIterable<string> & PromiseLike<string>` | Same dual interface for `reasoning` content blocks.                                                      |
| `usage`            | `PromiseLike<UsageInfo \| undefined>`         | Resolves on `message-finish` with token counts.                                                          |
| `blocks`           | `ContentBlock[]`                              | Live mutable view of all content blocks (text, reasoning, tool calls, media).                            |
| `assembled`        | `AssembledMessage`                            | Low-level assembler snapshot (namespace, node, messageId, metadata, blocks, usage, error).               |
| `namespace`        | `string[]`                                    | Subgraph namespace path. `[]` at the root.                                                               |
| `node`             | `string \| undefined`                         | Graph node that emitted this message.                                                                    |
| `messageId`        | `string \| undefined`                         | Stable id across `message-start → message-finish`.                                                       |
| `metadata`         | `MessageMetadata \| undefined`                | Provider / model metadata, if the server attached any.                                                   |

### Token-by-token

```ts
for await (const message of thread.messages) {
  const node = message.node ?? "unknown";
  process.stdout.write(`[${node}] `);

  for await (const token of message.text) {
    process.stdout.write(token);
  }

  const usage = await message.usage;
  if (usage) {
    process.stdout.write(
      `  (in: ${usage.input_tokens ?? 0}, out: ${usage.output_tokens ?? 0})\n`
    );
  }
}
```

### Full text only

If you don't care about streaming tokens, just `await`:

```ts
for await (const message of thread.messages) {
  const full = await message.text;
  console.log(`[${message.node}]`, full);
}
```

### Inspect tool-call blocks

Tool-call content blocks show up in `message.blocks` as they are
assembled. For a higher-level per-call view with promise-based
status/output/error, consume `thread.toolCalls` instead (see below).

## Tool calls: `thread.toolCalls`

Each element is an `AssembledToolCall`:

```ts
interface AssembledToolCall {
  readonly name: string;
  readonly callId: string;
  readonly namespace: string[];
  readonly input: unknown;
  readonly output: Promise<unknown>;
  readonly status: Promise<"running" | "finished" | "error">;
  readonly error: Promise<string | undefined>;
}
```

```ts
for await (const tc of thread.toolCalls) {
  console.log(`[tool] ${tc.name}(${JSON.stringify(tc.input)})`);
  const status = await tc.status;
  if (status === "finished") {
    console.log(`[tool] ${tc.name} →`, await tc.output);
  } else if (status === "error") {
    console.error(`[tool] ${tc.name} failed:`, await tc.error);
  }
}
```

Rejected `output` promises carry a default no-op `.catch()` internally,
so unhandled-rejection warnings are suppressed when the consumer only
awaits `status` + `error`.

## Final state: `thread.output` and `thread.values`

`thread.values` is both:

- An `AsyncIterable<State>` — yields every intermediate state snapshot
  as `values` events arrive.
- A `PromiseLike<State>` — `await thread.values` resolves with the
  final state when the run ends.

`thread.output` is identical to `await thread.values`, exposed as a
plain `Promise<State>` for convenience:

```ts
for await (const snapshot of thread.values) {
  console.log("tick", snapshot);
}
const final = await thread.output;
```

`values` is eagerly bootstrapped from `thread.run.start(...)` so that
`thread.output` always resolves with the run's final state regardless
of when you access it.

## Message coercion to `BaseMessage`

When a `values` snapshot's `messages` array contains plain serialized
messages (objects with `role`/`type`), the SDK automatically coerces
them into `@langchain/core/messages` class instances. You get the same
shape in-process and over the wire.

## Multi-consumer semantics

`thread.messages` is a shared buffer. Opening two loops in parallel
does **not** duplicate the server subscription — both cursors read from
the same buffered stream, and late consumers replay every past
message.

This is intentional and matches `useStream` selectors in the framework
packages.
