## Headless tools

`tools` registers local handlers that resolve server-emitted tool-call interrupts without a round-trip through the UI. When the server pauses on a matching tool-call interrupt, the binding runs `execute`, forwards the result with `respond()`, and resumes the stream — all without touching your template.

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    tools: [
      {
        name: "get_location",
        execute: async () => ({ lat: 37.77, lng: -122.42 }),
      },
    ],
    onTool: (event) => console.log(event.type, event.name),
  });
</script>
```

### Tool implementation shape

| Field     | Type                                         | Description                                                     |
| --------- | -------------------------------------------- | --------------------------------------------------------------- |
| `name`    | `string`                                     | Must match the tool name the server will request.               |
| `execute` | `(args, ctx) => unknown \| Promise<unknown>` | Called with the parsed tool-call arguments; return the payload. |

### Observing lifecycle events

Pass `onTool` to observe the full lifecycle:

```ts
onTool: (event) => {
  switch (event.type) {
    case "start":   /* tool matched, execute() invoked */ break;
    case "success": /* execute resolved; server resuming */ break;
    case "error":   /* execute threw or respond() failed */ break;
  }
};
```

Dedupe is automatic: the same interrupt observed twice (for example under HMR) is invoked once.
