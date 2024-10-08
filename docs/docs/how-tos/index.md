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

- [How to define graph state](define-state.ipynb)
- [How to create subgraphs](subgraph.ipynb)
- [How to create branches for parallel execution](branching.ipynb)
- [How to create map-reduce branches for parallel execution](map-reduce.ipynb)

## Persistence

LangGraph.js makes it easy to persist state across graph runs. The guides below shows how to add persistence to your graph.

- [How to add persistence ("memory") to your graph](persistence.ipynb)
- [How to manage conversation history](manage-conversation-history.ipynb)
- [How to view and update past graph state](time-travel.ipynb)
- [How to delete messages](delete-messages.ipynb)
- [How to add summary of the conversation history](add-summary-conversation-history.ipynb)

## Human-in-the-loop

One of LangGraph.js's main benefits is that it makes human-in-the-loop workflows easy.
These guides cover common examples of that.

- [How to add breakpoints](breakpoints.ipynb)
- [How to add dynamic breakpoints](dynamic_breakpoints.ipynb)
- [How to wait for user input](wait-user-input.ipynb)
- [How to edit graph state](edit-graph-state.ipynb)
- [How to review tool calls](review-tool-calls.ipynb)

## Streaming

LangGraph is built to be streaming first.
These guides show how to use different streaming modes.

- [How to stream full state of your graph](stream-values.ipynb)
- [How to stream state updates of your graph](stream-updates.ipynb)
- [How to configure multiple streaming modes](stream-multiple.ipynb)
- [How to stream LLM tokens](stream-tokens.ipynb)
- [How to stream LLM tokens without LangChain models](streaming-tokens-without-langchain.ipynb)
- [How to stream events from within a tool](streaming-events-from-within-tools.ipynb)
- [How to stream from the final node](streaming-from-final-node.ipynb)

## Tool calling

- [How to call tools using ToolNode](tool-calling.ipynb)
- [How to force an agent to call a tool](force-calling-a-tool-first.ipynb)
- [How to handle tool calling errors](tool-calling-errors.ipynb)
- [How to pass runtime values to tools](pass-run-time-values-to-tools.ipynb)

## Subgraphs

- [How to create subgraphs](subgraph.ipynb)
- [How to manage state in subgraphs](subgraphs-manage-state.ipynb)
- [How to transform inputs and outputs of a subgraph](subgraph-transform-state.ipynb)

## State management

- [Have a separate input and output schema](input_output_schema.ipynb)
- [Pass private state between nodes inside the graph](pass_private_state.ipynb)

## Prebuilt ReAct Agent

- [How to create a ReAct agent](create-react-agent.ipynb)
- [How to add memory to a ReAct agent](react-memory.ipynb)
- [How to add a system prompt to a ReAct agent](react-system-prompt.ipynb)
- [How to add Human-in-the-loop to a ReAct agent](react-human-in-the-loop.ipynb)

## Prebuilt ReAct Agent

- [How to create a ReAct agent](create-react-agent.ipynb)
- [How to add memory to a ReAct agent](react-memory.ipynb)
- [How to add a system prompt to a ReAct agent](react-system-prompt.ipynb)
- [How to add Human-in-the-loop to a ReAct agent](react-human-in-the-loop.ipynb)

## Other

- [How to add runtime configuration to your graph](configuration.ipynb)
- [How to let agent return tool results directly](dynamically-returning-directly.ipynb)
- [How to have agent respond in structured format](respond-in-format.ipynb)
- [How to manage agent steps](managing-agent-steps.ipynb)
- [How to add node retry policies](node-retry-policies.ipynb)
