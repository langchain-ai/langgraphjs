# How-to guides

Welcome to the LangGraphJS How-to Guides! These guides provide practical, step-by-step instructions for accomplishing key tasks in LangGraphJS.

## In progress

🚧 This section is currently in progress. More updates to come! 🚧

## Core

The core guides show how to address common needs when building a out AI workflows, with special focus placed on [ReAct](https://arxiv.org/abs/2210.03629)-style agents with [tool calling](https://js.langchain.com/v0.2/docs/how_to/tool_calling/).

- [Persistence](persistence.ipynb): How to give your graph "memory" and resiliance by saving and loading state
- [Time travel](time-travel.ipynb): How to navigate and manipulate graph state history once it's persisted
- [Stream tokens](stream-tokens.ipynb): How to stream tokens and tool calls from your agent within a graph
- [Configuration](configuration.ipynb): How to indicate that a graph can swap out configurable components

### Design patterns

How to apply common design patterns in your workflows:

- [Subgraphs](subgraph.ipynb): How to compose subgraphs within a larger graph
- [Branching](branching.ipynb): How to create branching logic in your graphs for parallel node execution
- [Human-in-the-loop](human-in-the-loop.ipynb): How to incorporate human feedback and intervention

The following examples are useful especially if you are used to LangChain's AgentExecutor configurations.

- [Force calling a tool first](force-calling-a-tool-first.ipynb): Define a fixed workflow before ceding control to the ReAct agent
- [Dynamic direct return](dynamically-returning-directly.ipynb): Let the LLM decide whether the graph should finish after a tool is run or whether the LLM should be able to review the output and keep going
- [Respond in structured format](respond-in-format.ipynb): Let the LLM use tools or populate schema to provide the user. Useful if your agent should generate structured content