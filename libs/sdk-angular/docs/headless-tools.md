# Headless tools

Register browser-side tool implementations with `tools` / `onTool`.
Interrupts that target a registered tool are invoked and auto-resumed
with the handler's return value — no template plumbing needed.

```typescript
import { injectStream } from "@langchain/angular";
import { tool } from "langchain";
import { z } from "zod";

const getCurrentLocation = tool(
  async () => ({ lat: 40.71, lon: -74.01 }),
  {
    name: "get_current_location",
    schema: z.object({}),
  },
);

readonly stream = injectStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  tools: [getCurrentLocation],
  onTool: (event) => {
    if (event.type === "error") console.error(event.error);
  },
});
```

## When to use headless tools

Headless tools are the right fit when the tool needs **browser-only
capabilities** — geolocation, camera/microphone, clipboard, Web
Crypto, IndexedDB, DOM selection, OS share sheets. The server-side
agent calls the tool abstractly; the browser supplies the concrete
implementation and the runtime stitches the result back in.

## `onTool` lifecycle

`onTool` receives discriminated-union events you can narrow by
`event.type`:

- `"start"` — the interrupt arrived and the handler is about to run.
- `"result"` — the handler returned successfully; the run is being
  resumed with the value.
- `"error"` — the handler threw or rejected; the run is resumed with
  an error payload.

Use this for telemetry or surfacing per-tool loading states — the
runtime still handles resume/retry automatically.

## Matching tools to interrupts

An interrupt targets a registered tool when its `tool_name` matches
the `name` passed to `tool(…)`. Unmatched interrupts fall through to
`stream.interrupts()` so you can render a UI fallback. See
[Handling interrupts](./interrupts.md).

## Related

- [Handling interrupts](./interrupts.md)
- [`injectStream` options](./inject-stream.md#options)
