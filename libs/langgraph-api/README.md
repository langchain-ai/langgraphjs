# LangGraph.js API

In-memory implementation of the LangGraph.js API.

## Graph factories

A graph export can be a factory. The native Node server passes the existing
config argument and a second `GraphFactoryRuntime` argument:

```typescript
import type { GraphFactoryRuntime } from "@langchain/langgraph-api/graph";

export async function graph(
  config: { configurable?: Record<string, unknown> },
  runtime: GraphFactoryRuntime<{ model?: string }>
) {
  const execution = runtime.executionRuntime;
  // Read run context before constructing the graph.
  const model = execution?.context?.model ?? "default";
  return buildGraph({ model, config });
}
```

`buildGraph` above stands for your graph construction function. Existing factories
that accept only config continue to work.

| `accessContext` | Operation | `executionRuntime` |
| --- | --- | --- |
| `threads.create_run` | Run execution, including interrupt resumes and retries | `{ context }` |
| `threads.read` | State reads and history | `null` |
| `threads.update` | State updates and bulk updates | `null` |
| `assistants.read` | Schemas, graph diagrams, and subgraphs | `null` |

During execution, `context` is the saved run context, including assistant defaults
and run overrides. It is the same context passed to graph execution. It can be
empty or absent, so check `executionRuntime` to distinguish execution from other
operations. A resume uses the resume run's context; reconnecting to a stream does
not construct a new graph.

Use the runtime to select resources for the current run. Keep nodes, edges, and
state schemas consistent across execution, inspection, and state operations.
Context has not been validated against the returned graph's schema when the
factory runs. Validate any values needed during construction. Application context
is not proof of an authenticated identity.

Custom operation backends can pass `runtime` in the options to `getGraph`. Calls
that omit it default to `assistants.read`. This API applies to native Node graph
factories; it does not add factories to `createEmbedServer` or change the separate
JavaScript bridge in the Python Agent Server.

## Tests

1. Build the latest code changes to test: `pnpm build`
1. Start a local server: `pnpm dev`
1. Run the tests: `pnpm test`
