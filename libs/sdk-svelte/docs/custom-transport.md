## Custom transport

Pass an `AgentServerAdapter` to stream from a backend that isn't a LangGraph-Platform server. The custom branch is a drop-in peer of the agent-server branch — selectors, interrupts, queue, headless tools all work the same.

### `HttpAgentServerAdapter`

`HttpAgentServerAdapter` is a convenience wrapper over HTTP / SSE. Point it at any endpoint that speaks the v2 streaming protocol:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  import { HttpAgentServerAdapter } from "@langchain/langgraph-sdk/stream";

  const stream = useStream({
    transport: new HttpAgentServerAdapter({
      url: "https://my-api.example.com/stream",
    }),
    onThreadId: (id) => console.log("Thread created:", id),
  });
</script>
```

Common scenarios:

- Next.js / SvelteKit route handlers that proxy to your own backend.
- A self-hosted Python service that speaks the v2 protocol.
- A test stub during integration tests.

### Custom adapter interface

For full control, implement the `AgentServerAdapter` contract directly:

```ts
interface AgentServerAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  send(command: Command, options: { signal?: AbortSignal }): Promise<void>;
  subscribe(options: {
    onEvent: (event: ProtocolEvent) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;

  // Optional:
  getState?(): Promise<ThreadState>;
  getHistory?(options?: { limit?: number }): Promise<ThreadState[]>;
  openEventStream?(options?): Promise<ReadableStream<Uint8Array>>;
}
```

The LangGraph-Platform client is **not** constructed when a custom adapter is passed, so bundles that only use a custom adapter tree-shake the entire built-in SSE / WebSocket stack.

### When to prefer `sse` + `fetch` override

If you just need header-based auth or request rewriting against a LangGraph-compatible server, the built-in `"sse"` transport + a `fetch` override is usually enough:

```svelte
<script lang="ts">
  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    transport: "sse",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-api-key", "my-key");
      return fetch(input, { ...init, headers });
    },
  });
</script>
```
