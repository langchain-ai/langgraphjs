# LangGraph.js API

This package implements the LangGraph API for rapid development and testing. Build and iterate on LangGraph.js agents with a tight feedback loop. The server is backed by a predominently in-memory data store that is persisted to local disk.

For production use, see the various [deployment options](https://langchain-ai.github.io/langgraph/concepts/deployment_options/) for the LangGraph API, which are backed by a production-grade database.

## Installation

Install the `@langchain/langgraph-api` package via your package manager of choice.

```bash
npm install @langchain/langgraph-api
```

## Usage

Start the development server:

```bash
npm run langgraph dev
```

Your agent's state (threads, runs, assistants, store) persists in memory while the server is running - perfect for development and testing. Each run's state is tracked and can be inspected, making it easy to debug and improve your agent's behavior.

