# LangGraph.js API

In-memory implementation of the LangGraph.js API.

## Graph factories

The native Node server calls graph factories with a `GraphFactoryConfig`, which
extends `LangGraphRunnableConfig` with a server-supplied `accessContext`:

```typescript
import type { GraphFactoryConfig } from "@langchain/langgraph-api/graph";

export async function graph(config: GraphFactoryConfig<{ model?: string }>) {
  const model = config.context?.model ?? "default";
  return buildGraph({ model, config });
}
```

`buildGraph` stands for your graph construction function. Existing factories that
read only `configurable` continue to work.

| `accessContext` | Operation | `context` |
| --- | --- | --- |
| `threads.create_run` | Run execution, including interrupt resumes and retries | Saved run context |
| `threads.read` | State reads and history | `undefined` |
| `threads.update` | State updates and bulk updates | `undefined` |
| `assistants.read` | Schemas, graph diagrams, and subgraphs | `undefined` |

Run context includes assistant defaults and run overrides. It can be empty or
absent, so check `config.accessContext === "threads.create_run"` before setup
that is only needed for execution. A resume uses the resume run's context;
reconnecting to a stream does not construct a new graph.

Keep nodes, edges, and state schemas consistent across all operations. Context
has not been validated against the returned graph's schema when the factory runs.
Validate values needed during construction. Application context is not proof of
an authenticated identity.

Custom operation backends pass `accessContext` and `context` in the options to
`getGraph`. The operation defaults to `assistants.read`. The loader sets these
factory fields without changing the caller's config and discards context for
non-execution operations.

## Tests

1. Build the latest code changes to test: `pnpm build`
1. Start a local server: `pnpm dev`
1. Run the tests: `pnpm test`
