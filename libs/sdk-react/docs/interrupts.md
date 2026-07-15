# Interrupts & headless tools

Interrupts pause graph execution and wait for input. `@langchain/react` surfaces them on the root hook, lets you resume them imperatively, and can auto-resolve tool-interrupts via registered headless tool implementations.

## Table of contents

- [Reading interrupts](#reading-interrupts)
- [Resuming an interrupt](#resuming-an-interrupt)
- [Multiple pending interrupts](#multiple-pending-interrupts)
- [Subgraph interrupts and namespace](#subgraph-interrupts-and-namespace)
- [`respond(response, options?)`](#respondresponse-options)
- [`respondAll(responsesById, options?)`](#respondallresponsesbyid-options)
- [Headless tools](#headless-tools)
- [Lower-level helpers](#lower-level-helpers)

## Reading interrupts

The root hook exposes the latest interrupt and the full list:

```tsx
const stream = useStream<
  { messages: BaseMessage[] },
  { question: string } // InterruptType
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

return (
  <>
    {stream.messages.map((msg, i) => (
      <div key={msg.id ?? i}>{String(msg.content)}</div>
    ))}

    {stream.interrupt && (
      <div>
        <p>{stream.interrupt.value.question}</p>
        <button onClick={() => void stream.respond("Approved")}>
          Approve
        </button>
      </div>
    )}
  </>
);
```

`stream.interrupt` is `stream.interrupts[0]` — the most recent **root** interrupt mirrored for UI convenience. It is not always the interrupt `respond()` would pick when `target` is omitted (see below).

## Resuming an interrupt

Call `stream.respond(value)` when exactly one interrupt is pending:

```tsx
void stream.respond({ approved: true });
```

When more than one interrupt can be active, pass an explicit target (see [Multiple pending interrupts](#multiple-pending-interrupts) and [Subgraph interrupts and namespace](#subgraph-interrupts-and-namespace)).

## Multiple pending interrupts

When `options.interruptId` is omitted, `respond()` walks `stream.getThread()?.interrupts` from **newest to oldest** and resumes the first entry whose `interruptId` has not already been resolved by a prior `respond()` call.

That list includes root **and** subgraph interrupts. It is **not** the same as `stream.interrupt` / `stream.interrupts[0]`, which only mirror root-namespace interrupts.

| Surface | What it contains | Use for |
| ------- | ---------------- | ------- |
| `stream.interrupts` | Root-namespace interrupts (`{ id, value }`) | Rendering root HITL UI |
| `stream.getThread()?.interrupts` | All protocol interrupts (`{ interruptId, payload, namespace }`) | Targeting + namespace for `respond()` |

When several root interrupts are pending, target by id:

```tsx
stream.interrupts.map((intr) => (
  <button
    key={intr.id}
    onClick={() =>
      void stream.respond({ approved: true }, { interruptId: intr.id! })
    }
  >
    Approve {intr.id}
  </button>
));
```

Root interrupts use `namespace: []`. You can omit `namespace` in the target — it defaults to the root tuple.

## Subgraph interrupts and namespace

Interrupts raised inside a subagent or nested graph carry a **non-empty** protocol `namespace` tuple (for example `["task:research"]`). The server validates that tuple when you resume.

Those entries appear on `stream.getThread()?.interrupts` but may **not** appear on `stream.interrupts`. Read `namespace` from the thread stream entry — do not guess it from UI state:

```tsx
const thread = stream.getThread();

return (
  <>
    {thread?.interrupts.map((entry) => (
      <div key={entry.interruptId}>
        <p>{JSON.stringify(entry.payload)}</p>
        <p>
          namespace: {entry.namespace.length === 0 ? "(root)" : entry.namespace.join(" › ")}
        </p>
        <button
          onClick={() =>
            void stream.respond(buildResponse(entry.payload), {
              interruptId: entry.interruptId,
              namespace: entry.namespace,
            })
          }
        >
          Resume
        </button>
      </div>
    ))}
  </>
);
```

Each entry mirrors an `input.requested` event: `{ interruptId, payload, namespace }`. Pass both `interruptId` and `namespace` for subgraph interrupts; omitting `namespace` assumes root (`[]`) and the server will reject the resume if the pending interrupt lives in a subgraph.

## `respond(response, options?)`

Signature:

```tsx
stream.respond(
  response: unknown,
  options?: {
    interruptId?: string;
    namespace?: string[];
    update?: Record<string, unknown> | [string, unknown][];
    goto?: string | { node: string; input?: unknown } | (string | { node: string; input?: unknown })[];
    config?: { configurable?: Record<string, unknown>; [key: string]: unknown };
    metadata?: Record<string, unknown>;
  },
): Promise<void>
```

| `options.interruptId` | Behavior |
| --------------------- | -------- |
| Omitted | Newest unresolved entry in `getThread()?.interrupts`. Safe when one interrupt is pending. |
| `interruptId` set | Resume that id at root (`namespace: []`). |
| `interruptId` + `namespace` | Resume that id in the given subgraph namespace. Required when the interrupt is not at root. |

`options.config` / `options.metadata` are folded into the run that services the resume — the same `config` / `metadata` you'd pass to `submit()`. Use them to carry model/user config or run metadata (e.g. trigger source) onto a HITL resume.

```tsx
// Single pending interrupt — omit target:
await stream.respond({ approved: true });

// Specific root interrupt:
await stream.respond({ approved: true }, { interruptId: myInterrupt.id! });

// Subgraph interrupt — namespace from getThread():
await stream.respond(
  { approved: true },
  { interruptId: entry.interruptId, namespace: entry.namespace },
);

// Resume carrying run config + metadata:
await stream.respond({ approved: true }, {
  config: { configurable: { model: "gpt-4o" } },
  metadata: { source: "ui" },
});
```

### Changing state while resuming

Pass `options.update` to apply a state update in the **same superstep** as the resume — it maps to LangGraph's `Command(resume, update)`. The resumed run produces a single checkpoint reflecting both the resume value and the update: no separate `updateState` write, no intermediate checkpoint, no flicker.

The canonical use case is a HITL flow where the UI pushes the interrupt card (e.g. an `AIMessage`) into state at the moment it answers the interrupt, so the card is committed before the resumed tool runs and stays rendered without the backend re-emitting it.

`update` accepts a state-keys object (shallow-merged via the graph's channel reducers) or a list of `[key, value]` entries. Messages under the configured `messagesKey` may be plain dicts **or** `@langchain/core` `BaseMessage` instances — instances are serialized to dicts before transport, exactly like `submit()`.

```tsx
import { AIMessage } from "@langchain/core/messages";

// Approve the interrupt AND push a message into state in one atomic resume:
await stream.respond(
  { approved: true },
  { update: { messages: [new AIMessage("Approved by reviewer.")] } },
);

// Equivalent with a plain message dict:
await stream.respond(
  { approved: true },
  { update: { messages: [{ type: "ai", content: "Approved by reviewer." }] } },
);
```

You can also pass `options.goto` to apply a directed jump (`Command(goto=...)`) in the same superstep — a target node name, a `Send` (`{ node, input }`), or a list mixing the two for fan-out.

### `respondAll(responsesById, options?)`

When a run pauses on **several interrupts at the same checkpoint** (e.g. parallel tool-authorization prompts), resume them in one command with `respondAll`. Sequential `respond()` calls would fail — the first resume starts a run, leaving the rest with no interrupted run to respond to.

```tsx
stream.respondAll(
  responsesById: Record<string, unknown>, // interruptId -> response payload
  options?: {
    config?: { configurable?: Record<string, unknown>; [key: string]: unknown };
    metadata?: Record<string, unknown>;
  },
): Promise<void>
```

`responsesById` maps each pending `interruptId` to its response, so different interrupts can receive different payloads. Namespaces are resolved internally from `getThread()?.interrupts`, so you only supply ids. `options.config` / `options.metadata` are folded into the single run that services the batched resume.

```tsx
// Distinct payloads per interrupt:
await stream.respondAll({
  [interruptA.id]: { approved: true },
  [interruptB.id]: { approved: false },
});

// Same payload to every pending interrupt:
await stream.respondAll(
  Object.fromEntries(stream.interrupts.map((i) => [i.id!, { approved: true }])),
);
```

## Headless tools

Register tool implementations on the hook and the SDK will auto-resume matching interrupts with the handler's return value. The user never sees the tool interrupt — it resolves transparently:

```tsx
import { useStream } from "@langchain/react";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getCurrentLocation = tool(
  async () => ({
    latitude: 47.61,
    longitude: -122.33,
  }),
  {
    name: "get_current_location",
    description: "Get the user's current location",
    schema: z.object({}),
  },
);

const stream = useStream({
  assistantId: "deep-agent",
  apiUrl: "http://localhost:2024",
  tools: [getCurrentLocation],
  onTool: (event) => {
    if (event.type === "error") console.error(event.error);
  },
});
```

`onTool` lifecycle events:

| `event.type` | Description                                        |
| ------------ | -------------------------------------------------- |
| `start`      | The SDK matched an interrupt to a registered tool. |
| `success`    | Tool returned a value; the run is about to resume. |
| `error`      | Tool threw; the error is surfaced to the server.   |

Dedupe is automatic: the same interrupt observed twice (for example under `<StrictMode>`) is invoked once.

## Lower-level helpers

For advanced composition (custom interrupt routers, background workers, tests) the SDK also exports:

- `flushPendingHeadlessToolInterrupts(stream)`
- `findHeadlessTool(stream, name)`
- `handleHeadlessToolInterrupt(stream, interrupt, tool)`

These are the same primitives `useStream` uses internally to service `tools` / `onTool`. Reach for them when you need to process interrupts outside of the default auto-resume pipeline.
