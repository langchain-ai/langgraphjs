# Interrupts & headless tools

Interrupts pause graph execution and wait for input. `@langchain/react` surfaces them on the root hook, lets you resume them imperatively, and can auto-resolve tool-interrupts via registered headless tool implementations.

## Table of contents

- [Reading interrupts](#reading-interrupts)
- [Resuming an interrupt](#resuming-an-interrupt)
- [`respond(response, target?)`](#respondresponse-target)
- [Headless tools](#headless-tools)
- [Lower-level helpers](#lower-level-helpers)

## Reading interrupts

The root hook exposes the latest interrupt and the full list:

```tsx
const { messages, interrupt, submit } = useStream<
  { messages: BaseMessage[] },
  { question: string } // InterruptType
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

return (
  <>
    {messages.map((msg, i) => (
      <div key={msg.id ?? i}>{String(msg.content)}</div>
    ))}

    {interrupt && (
      <div>
        <p>{interrupt.value.question}</p>
        <button
          onClick={() => void submit(null, { command: { resume: "Approved" } })}
        >
          Approve
        </button>
      </div>
    )}
  </>
);
```

## Resuming an interrupt

The most ergonomic way to resume the most-recent root interrupt is `submit(null, { command: { resume: value } })`:

```tsx
void submit(null, { command: { resume: { approved: true } } });
```

This re-uses the active transport session and is equivalent to `respond(value)` for root-scoped interrupts.

## `respond(response, target?)`

When multiple concurrent interrupts are in flight (subagents, fan-out, nested graphs), call `stream.respond()` with an explicit target:

```tsx
// Latest root interrupt:
await stream.respond({ approved: true });

// Specific interrupt by id, on a subagent namespace:
await stream.respond(
  { approved: true },
  { interruptId: myInterrupt.id, namespace: ["subagent"] },
);
```

The target object accepts `{ interruptId, namespace? }`. `namespace` scopes the resolution to a subagent or subgraph.

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
