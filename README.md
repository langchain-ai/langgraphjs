# 🦜🕸️LangGraph.js

[![Docs](https://img.shields.io/badge/docs-latest-blue)](https://langchain-ai.github.io/langgraphjs/)
![Version](https://img.shields.io/npm/v/@langchain/langgraph?logo=npm)  
[![Downloads](https://img.shields.io/npm/dm/@langchain/langgraph)](https://www.npmjs.com/package/@langchain/langgraph)
[![Open Issues](https://img.shields.io/github/issues-raw/langchain-ai/langgraphjs)](https://github.com/langchain-ai/langgraphjs/issues)
[![](https://dcbadge.vercel.app/api/server/6adMQxSpJS?compact=true&style=flat)](https://discord.com/channels/1038097195422978059/1170024642245832774)

⚡ Building language agents as graphs ⚡

## Overview

[LangGraph.js](https://langchain-ai.github.io/langgraphjs/) is a library for building stateful, multi-actor applications with LLMs, used to create agent and multi-agent workflows. Built on top of [LangChain.js](https://github.com/langchain-ai/langchainjs), it offers these core benefits compared to other LLM frameworks: cycles, controllability, and persistence. LangGraph allows you to define flows that involve cycles, essential for most agentic architectures, differentiating it from DAG-based solutions. As a very low-level framework, it provides fine-grained control over both the flow and state of your application, crucial for creating reliable agents. Additionally, LangGraph includes built-in persistence, enabling advanced human-in-the-loop and memory features.

LangGraph is inspired by [Pregel](https://research.google/pubs/pub37252/) and [Apache Beam](https://beam.apache.org/). The public interface draws inspiration from [NetworkX](https://networkx.org/documentation/latest/). LangGraph is built by LangChain Inc, the creators of LangChain, but can be used without LangChain.

### Key Features

- **Cycles and Branching**: Implement loops and conditionals in your apps.
- **Persistence**: Automatically save state after each step in the graph. Pause and resume the graph execution at any point to support error recovery, human-in-the-loop workflows, time travel and more.
- **Human-in-the-Loop**: Interrupt graph execution to approve or edit next action planned by the agent.
- **Streaming Support**: Stream outputs as they are produced by each node (including token streaming).
- **Integration with LangChain**: LangGraph integrates seamlessly with [LangChain](https://github.com/langchain-ai/langchainjs/) and [LangSmith](https://docs.smith.langchain.com/) (but does not require them).

## Installation

```bash
npm install @langchain/langgraph
```

## Example

One of the central concepts of LangGraph is state. Each graph execution creates a state that is passed between nodes in the graph as they execute, and each node updates this internal state with its return value after it executes. The way that the graph updates its internal state is defined by either the type of graph chosen or a custom function.

Let's take a look at a simple example of an agent that can search the web using [Tavily Search API](https://tavily.com/).

First install the required dependencies:

```bash
npm install @langchain/openai @langchain/community
```

Then set the required environment variables:

```bash
export OPENAI_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
```

Optionally, set up [LangSmith](https://docs.smith.langchain.com/) for best-in-class observability:

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=ls__...
```

Now let's define our agent:

```typescript
import { HumanMessage } from "@langchain/core/messages";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatOpenAI } from "@langchain/openai";
import { END, START, StateGraph, StateGraphArgs } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// Define the state interface
interface AgentState {
  messages: HumanMessage[];
}

// Define the graph state
const graphState: StateGraphArgs<AgentState>["channels"] = {
  messages: {
    value: (x: HumanMessage[], y: HumanMessage[]) => x.concat(y),
    default: () => [],
  },
};

// Define the tools for the agent to use
const tools = [new TavilySearchResults({ maxResults: 1 })];
const toolNode = new ToolNode<AgentState>(tools);

const model = new ChatOpenAI({ temperature: 0 }).bindTools(tools);

// Define the function that determines whether to continue or not
function shouldContinue(state: AgentState): "tools" | typeof END {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  // If the LLM makes a tool call, then we route to the "tools" node
  if (lastMessage.additional_kwargs.tool_calls) {
    return "tools";
  }
  // Otherwise, we stop (reply to the user)
  return END;
}

// Define the function that calls the model
async function callModel(state: AgentState) {
  const messages = state.messages;
  const response = await model.invoke(messages);

  // We return a list, because this will get added to the existing list
  return { messages: [response] };
}

// Define a new graph
const workflow = new StateGraph<AgentState>({ channels: graphState })
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

// Initialize memory to persist state between graph runs
const checkpointer = new MemorySaver();

// Finally, we compile it!
// This compiles it into a LangChain Runnable.
// Note that we're (optionally) passing the memory when compiling the graph
const app = workflow.compile({ checkpointer });

// Use the Runnable
const finalState = await app.invoke(
  { messages: [new HumanMessage("what is the weather in sf")] },
  { configurable: { thread_id: "42" } }
);
console.log(finalState.messages[finalState.messages.length - 1].content);
```

This will output:

```
The current weather in San Francisco is as follows:
- Temperature: 60.1°F (15.6°C)
- Condition: Partly cloudy
- Wind: 5.6 mph (9.0 kph) from SSW
- Humidity: 83%
- Visibility: 9.0 miles (16.0 km)
- UV Index: 4.0

For more details, you can visit [Weather API](https://www.weatherapi.com/).
```

Now when we pass the same `"thread_id"`, the conversation context is retained via the saved state (i.e. stored list of messages):

```typescript
const nextState = await app.invoke(
  { messages: [new HumanMessage("what about ny")] },
  { configurable: { thread_id: "42" } }
);
console.log(nextState.messages[nextState.messages.length - 1].content);
```

```
The current weather in New York is as follows:
- Temperature: 20.3°C (68.5°F)
- Condition: Overcast
- Wind: 2.2 mph from the north
- Humidity: 65%
- Cloud Cover: 100%
- UV Index: 5.0

For more details, you can visit [Weather API](https://www.weatherapi.com/).
```

### Step-by-step Breakdown

1. <details>
    <summary>Initialize the model and tools.</summary>

   - We use `ChatOpenAI` as our LLM. **NOTE:** We need make sure the model knows that it has these tools available to call. We can do this by converting the LangChain tools into the format for OpenAI tool calling using the `.bindTools()` method.
   - We define the tools we want to use -- a web search tool in our case. It is really easy to create your own tools - see documentation [here](https://js.langchain.com/docs/modules/agents/tools/dynamic) on how to do that.
   </details>

2. <details>
    <summary>Initialize graph with state.</summary>

   - We initialize the graph (`StateGraph`) by passing the state interface (`AgentState`).
   - The `graphState` object defines how updates from each node should be merged into the graph's state.
   </details>

3. <details>  
    <summary>Define graph nodes.</summary>

   There are two main nodes we need:

   - The `agent` node: responsible for deciding what (if any) actions to take.
   - The `tools` node that invokes tools: if the agent decides to take an action, this node will then execute that action.
   </details>

4. <details>
    <summary>Define entry point and graph edges.</summary>

   First, we need to set the entry point for graph execution - the `agent` node. We do this by
   creating an edge from the virtual `START` node to the `agent` node.

   Then we define one normal and one conditional edge. A conditional edge means that the destination depends on the contents of the graph's state (`AgentState`). In our case, the destination is not known until the agent (LLM) decides.

   - Conditional edge: after the agent is called, we should either:
     - a. Run tools if the agent said to take an action, OR
     - b. Finish (respond to the user) if the agent did not ask to run tools
   - Normal edge: after the tools are invoked, the graph should always return to the agent to decide what to do next
   </details>

5. <details>
    <summary>Compile the graph.</summary>

   - When we compile the graph, we turn it into a LangChain [Runnable](https://js.langchain.com/docs/expression_language/), which automatically enables calling `.invoke()`, `.stream()` and `.batch()` with your inputs.
   - We can also optionally pass a checkpointer object for persisting state between graph runs, enabling memory, human-in-the-loop workflows, time travel and more. In our case we use `MemorySaver` - a simple in-memory checkpointer.
   </details>

6. <details>
   <summary>Execute the graph.</summary>

   1. LangGraph adds the input message to the internal state, then passes the state to the entrypoint node, `"agent"`.
   2. The `"agent"` node executes, invoking the chat model.
   3. The chat model returns an `AIMessage`. LangGraph adds this to the state.
   4. The graph cycles through the following steps until there are no more `tool_calls` on the `AIMessage`:
      - If `AIMessage` has `tool_calls`, the `"tools"` node executes.
      - The `"agent"` node executes again and returns an `AIMessage`.
   5. Execution progresses to the special `END` value and outputs the final state.

   As a result, we get a list of all our chat messages as output.
   </details>

## Documentation

- [Tutorials](https://langchain-ai.github.io/langgraphjs/tutorials/): Learn to build with LangGraph through guided examples.
- [How-to Guides](https://langchain-ai.github.io/langgraphjs/how-tos/): Accomplish specific things within LangGraph, from streaming, to adding memory & persistence, to common design patterns (branching, subgraphs, etc.). These are the place to go if you want to copy and run a specific code snippet.
- [Conceptual Guides](https://langchain-ai.github.io/langgraphjs/concepts/): In-depth explanations of the key concepts and principles behind LangGraph, such as nodes, edges, state and more.
- [API Reference](https://langchain-ai.github.io/langgraphjs/reference/graphs/): Review important classes and methods, simple examples of how to use the graph and checkpointing APIs, higher-level prebuilt components and more.
