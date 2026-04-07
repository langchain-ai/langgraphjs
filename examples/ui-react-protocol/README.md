# UI React Protocol Testbed

Standalone example project for exercising the new LangGraph streaming protocol
from a Vite + React frontend.

It includes three agent targets exposed through `langgraph.json`:

- `stategraph`: a basic LangGraph `StateGraph`
- `create-agent`: a `createAgent(...)` workflow from `langchain`
- `deep-agent`: a Deep Agent with three protocol-focused subagents

The frontend talks directly to the new protocol endpoints and shows streamed
messages, tool activity, state snapshots, and subagent status. It also includes
a transport toggle so you can compare `HTTP+SSE` and `WebSocket` against the
same agent views.

## Run

Set your API key first:

```bash
export OPENAI_API_KEY=...
```

Optional:

```bash
export OPENAI_MODEL=gpt-4o-mini
```

From the repo root:

```bash
pnpm --filter @examples/ui-react-protocol dev
```

The LangGraph server starts on `http://localhost:2024` and the Vite client uses
that URL by default. You can override the client target with:

```bash
VITE_LANGGRAPH_API_URL=http://localhost:2024
```
