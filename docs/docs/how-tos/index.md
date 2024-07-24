---
hide:
  - toc
---

# How-to guides

Welcome to the LangGraph.js how-to Guides! These guides provide practical, step-by-step instructions for accomplishing key tasks in LangGraph.js.

## Installation

- [How to install and manage dependencies](manage-ecosystem-dependencies.ipynb)
- [How to use LangGraph.js in web environments](use-in-web-environments.ipynb)

## Controllability

LangGraph.js is known for being a highly controllable agent framework.
These how-to guides show how to achieve that controllability.

- [How to create subgraphs](subgraph.ipynb)
- [How to create branches for parallel execution](branching.ipynb)

## Persistence

LangGraph.js makes it easy to persist state across graph runs. The guides below shows how to add persistence to your graph.

- [How to add persistence ("memory") to your graph](persistence.ipynb)
- [How to manage conversation history](manage-conversation-history.ipynb)
- [How to view and update past graph state](time-travel.ipynb)
- [How to create a custom checkpointer using Postgres](persistence-postgres.ipynb)

## Human-in-the-loop

One of LangGraph.js's main benefits is that it makes human-in-the-loop workflows easy.
These guides cover common examples of that.

- [How to add human-in-the-loop](human-in-the-loop.ipynb)
- [How to add breakpoints](breakpoints.ipynb)
- [How to wait for user input](wait-user-input.ipynb)

## Streaming

LangGraph is built to be streaming first.
These guides show how to use different streaming modes.

- [How to stream full state of your graph](stream-values.ipynb)
- [How to stream state updates of your graph](stream-updates.ipynb)
- [How to stream LLM tokens](stream-tokens.ipynb)
- [How to stream LLM tokens without LangChain models](streaming-tokens-without-langchain.ipynb)

## Other

- [How to add runtime configuration to your graph](configuration.ipynb)
- [How to force an agent to call a tool](force-calling-a-tool-first.ipynb)
- [How to let agent return tool results directly](dynamically-returning-directly.ipynb)
- [How to handle tool calling errors](tool-calling-errors.ipynb)
- [How to have agent respond in structured format](respond-in-format.ipynb)
- [How to manage agent steps](managing-agent-steps.ipynb)
