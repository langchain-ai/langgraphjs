# Assistant-UI Claude Example

This example combines:

- `@assistant-ui/react` for the Claude-style chat surface
- `@langchain/react` for streaming LangGraph state on the frontend
- a basic `langchain` agent on the backend

## What it shows

- A Claude-inspired assistant-ui thread and composer
- A local single-agent graph powered by `langchain`
- How to bridge `@langchain/react` state into assistant-ui with `useExternalStoreRuntime`

## Setup

Create a local `.env` file in this folder with:

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
```

Optional overrides:

```bash
LANGGRAPH_API_URL=http://localhost:2024
VITE_LANGGRAPH_API_URL=http://localhost:2024
VITE_LANGGRAPH_ASSISTANT_ID=assistant-ui-claude
```

## Run

```bash
pnpm --filter @examples/assistant-ui-claude dev
```

Then open the Vite URL shown in the terminal, usually
[http://localhost:5173](http://localhost:5173).

The frontend talks directly to the LangGraph dev server at
`http://localhost:2024`, which serves the local `assistant-ui-claude` graph from
`langgraph.json`.
