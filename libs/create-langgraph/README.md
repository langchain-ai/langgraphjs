# create-langgraph

[![npm version](https://img.shields.io/npm/v/create-langgraph.svg)](https://www.npmjs.com/package/create-langgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official scaffolding tool for [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) projects. Quickly bootstrap new LangGraph applications from curated templates or generate configuration files for existing projects.

## Quick Start

Create a new LangGraph project with a single command:

```bash
# Using npm
npm init langgraph@latest

# Using yarn
yarn create langgraph

# Using pnpm
pnpm create langgraph

# Using bun
bunx create-langgraph
```

Follow the interactive prompts to select a template and configure your project.

## Templates

Choose from a variety of production-ready templates:

| Template                                                                             | Description                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [**New LangGraph Project**](https://github.com/langchain-ai/new-langgraphjs-project) | A simple, minimal chatbot with memory                           |
| [**ReAct Agent**](https://github.com/langchain-ai/react-agent-js)                    | A flexible agent that can be extended with many tools           |
| [**Memory Agent**](https://github.com/langchain-ai/memory-agent-js)                  | A ReAct-style agent with persistent memory across conversations |
| [**Retrieval Agent**](https://github.com/langchain-ai/retrieval-agent-template-js)   | An agent with retrieval-based question-answering                |
| [**Data-enrichment Agent**](https://github.com/langchain-ai/data-enrichment-js)      | An agent that performs web searches and organizes findings      |

### Using a Specific Template

Skip the interactive prompt by specifying a template directly:

```bash
npx create-langgraph@latest my-project --template react-agent-js
```

Available template IDs:

- `new-langgraph-project-js`
- `react-agent-js`
- `memory-agent-js`
- `retrieval-agent-js`
- `data-enrichment-js`

## Commands

### `create-langgraph [path]`

Creates a new LangGraph project at the specified path.

```bash
npx create-langgraph@latest my-awesome-agent
```

**Options:**

- `-t, --template <template>` — Use a specific template (skips interactive selection)

**What it does:**

1. Downloads the selected template from GitHub
2. Extracts it to your target directory
3. Optionally initializes a Git repository
4. Provides next steps for getting started

### `create-langgraph config [path]`

Scans your project for LangGraph agents and generates a `langgraph.json` configuration file.

```bash
# In your project directory
npx create-langgraph@latest config

# Or specify a path
npx create-langgraph@latest config ./my-project
```

This command is useful when:

- You have an existing project and want to add LangGraph Platform support
- You've added new agents and need to update your configuration
- You want to automatically detect all agents in your codebase

## Agent Detection

The `config` command automatically detects LangGraph agents defined using these patterns:

### ESM (ES Modules)

```typescript
// Using createAgent
export const agent = createAgent({ model, tools });

// Using StateGraph
export const graph = new StateGraph(annotation).compile();

// Using workflow builder pattern
export const app = workflow.compile();
```

### CommonJS

```javascript
// Using module.exports
module.exports.agent = createAgent({ model, tools });
module.exports.graph = workflow.compile();

// Using exports shorthand
exports.myAgent = createAgent({ model, tools });
```

### What Gets Detected

The scanner looks for:

- `createAgent()` function calls
- `new StateGraph(...).compile()` patterns
- `workflow.compile()` or `builder.compile()` patterns

**Important:** Only **exported** agents are included in the generated configuration. Unexported agents will be listed as warnings so you can add the `export` keyword if needed.

## Generated Configuration

The `config` command generates a `langgraph.json` file like this:

```json
{
  "node_version": "20",
  "graphs": {
    "agent": "./src/agent.ts:agent",
    "searchAgent": "./src/search.ts:searchAgent"
  },
  "env": ".env"
}
```

The configuration includes:

- **node_version** — Detected from your current Node.js version
- **graphs** — Map of agent names to their file paths and export names
- **env** — Path to `.env` file (if one exists)

## Project Structure

After scaffolding, your project will have this structure:

```txt
my-project/
├── src/
│   └── agent.ts       # Your LangGraph agent
├── langgraph.json     # LangGraph configuration
├── package.json
├── tsconfig.json
└── .env.example       # Environment variables template
```

## Next Steps After Creating a Project

```bash
# Navigate to your project
cd my-project

# Install dependencies
npm install  # or yarn, pnpm, bun

# Start the LangGraph development server
npx @langchain/langgraph-cli@latest dev
```

The development server provides:

- A local API server for your agents
- Hot reloading during development
- Built-in debugging tools

## Analytics

This CLI collects anonymous usage analytics to help improve the tool. The following information is collected:

- Operating system and version
- Node.js version
- CLI version
- Command executed

**No personal information, project details, or code is ever collected.**

To opt out of analytics, set the environment variable:

```bash
export LANGGRAPH_CLI_NO_ANALYTICS=1
```

## Requirements

- Node.js 18 or later
- npm, yarn, pnpm, or bun

## Related Packages

- [@langchain/langgraph](https://www.npmjs.com/package/@langchain/langgraph) — The core LangGraph library
- [@langchain/langgraph-cli](https://www.npmjs.com/package/@langchain/langgraph-cli) — CLI tools for running LangGraph projects

## License

MIT © [LangChain](https://langchain.com)
