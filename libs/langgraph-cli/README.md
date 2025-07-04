# LangGraph.js CLI

The official command-line interface for LangGraph.js, providing tools to create, develop, and deploy LangGraph.js applications.

## Installation

The `@langchain/langgraph-cli` is a CLI binary that can be run via `npx` or installed via your package manager of choice:

```bash
npx @langchain/langgraph-cli
```

## Commands

### `langgraphjs dev`

Run LangGraph.js API server in development mode with hot reloading.

```bash
npx @langchain/langgraph-cli dev
```

### `langgraphjs build`

Build a Docker image for your LangGraph.js application.

```bash
npx @langchain/langgraph-cli build
```

### `langgraphjs up`

Run LangGraph.js API server in Docker.

```bash
npx @langchain/langgraph-cli up
```

### `langgraphjs dockerfile`

Generate a Dockerfile for custom deployments

```bash
npx @langchain/langgraph-cli dockerfile <save path>
```

## Configuration

The CLI uses a `langgraph.json` configuration file with these key settings:

```json5
{
  // Required: Graph definitions
  graphs: {
    graph: "./src/graph.ts:graph",
  },

  // Optional: Node version (20 only at the moment)
  node_version: "20",

  // Optional: Environment variables
  env: ".env",

  // Optional: Additional Dockerfile commands
  dockerfile_lines: [],
}
```

See the [full documentation](https://langchain-ai.github.io/langgraph/cloud/reference/cli) for detailed configuration options.
