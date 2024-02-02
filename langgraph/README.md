# 🦜🕸️LangGraph.js

⚡ Building language agents as graphs ⚡

## Overview

LangGraph is a library for building stateful, multi-actor applications with LLMs, built on top of (and intended to be used with) [LangChain.js](https://github.com/langchain-ai/langchainjs). 
It extends the [LangChain Expression Language](https://js.langchain.com/docs/expression_language/) with the ability to coordinate multiple chains (or actors) across multiple steps of computation in a cyclic manner. 
It is inspired by [Pregel](https://research.google/pubs/pub37252/) and [Apache Beam](https://beam.apache.org/).
The current interface exposed is one inspired by [NetworkX](https://networkx.org/documentation/latest/).

The main use is for adding **cycles** to your LLM application.
Crucially, this is NOT a **DAG** framework.
If you want to build a DAG, you should use just use [LangChain Expression Language](https://js.langchain.com/docs/expression_language/).

Cycles are important for agent-like behaviors, where you call an LLM in a loop, asking it what action to take next.


> Looking for the Python version? Click [here](https://github.com/langchain-ai/langgraph).

## Installation

```bash
npm install @langchain/langgraph
```

## Quick Start

Here we will go over an example of recreating the [`AgentExecutor`](https://js.langchain.com/docs/modules/agents/concepts#agentexecutor) class from LangChain.
The benefits of creating it with LangGraph is that it is more modifiable.

We will also want to install some LangChain packages:

```shell
npm install langchain @langchain/core @langchain/community @langchain/openai
```

We also need to export some environment variables needed for our agent.

```shell
export OPENAI_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
```

Optionally, we can set up [LangSmith](https://docs.smith.langchain.com/) for best-in-class observability.

```shell
export LANGCHAIN_TRACING_V2="true"
export LANGCHAIN_API_KEY=ls__...
export LANGCHAIN_ENDPOINT=https://api.langchain.com
```

### Set up the tools

We will first define the tools we want to use.
For this simple example, we will use a built-in search tool via Tavily.
However, it is really easy to create your own tools - see documentation [here](https://js.langchain.com/docs/modules/agents/tools/dynamic) on how to do that.

```typescript
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";

const tools = [new TavilySearchResults({ maxResults: 1 })];
```

We can now wrap these tools in a simple ToolExecutor.
This is a real simple class that takes in a ToolInvocation and calls that tool, returning the output.

A ToolInvocation is any type with `tool` and `toolInput` attribute.


```typescript
import { ToolExecutor } from "@langchain/langgraph/prebuilt";

const toolExecutor = new ToolExecutor({
  tools
});
```

### Set up the model

Now we need to load the chat model we want to use.
Importantly, this should satisfy two criteria:

1. It should work with messages. We will represent all agent state in the form of messages, so it needs to be able to work well with them.
2. It should work with OpenAI function calling. This means it should either be an OpenAI model or a model that exposes a similar interface.

Note: these model requirements are not requirements for using LangGraph - they are just requirements for this one example.

```typescript
import { ChatOpenAI } from "@langchain/openai";

// We will set streaming=True so that we can stream tokens
// See the streaming section for more information on this.
const model = new ChatOpenAI({
  temperature: 0,
  streaming: true
});
```

After we've done this, we should make sure the model knows that it has these tools available to call.
We can do this by converting the LangChain tools into the format for OpenAI function calling, and then bind them to the model class.

```typescript
import { convertToOpenAIFunction } from "@langchain/core/utils/function_calling";

const toolsAsOpenAIFunctions = tools.map((tool) =>
  convertToOpenAIFunction(tool)
);
const newModel = model.bind({
  functions: toolsAsOpenAIFunctions,
});
```

### Define the agent state

The main type of graph in `langgraph` is the `StatefulGraph`.
This graph is parameterized by a state object that it passes around to each node.
Each node then returns operations to update that state.
These operations can either SET specific attributes on the state (e.g. overwrite the existing values) or ADD to the existing attribute.
Whether to set or add is denoted by annotating the state object you construct the graph with.

For this example, the state we will track will just be a list of messages.
We want each node to just add messages to that list.
Therefore, we will use an object with one key (`messages`) with the value as an object: `{ value: Function, default?: () => any }`

The `default` key must be a factory that returns the default value for that attribute.

```typescript
import { BaseMessage } from "@langchain/core/messages";

const agentState = {
  messages: {
    value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
    default: () => [],
  }
}
```

### Define the nodes

We now need to define a few different nodes in our graph.
In `langgraph`, a node can be either a function or a [runnable](https://js.langchain.com/docs/expression_language/).
There are two main nodes we need for this:

1. The agent: responsible for deciding what (if any) actions to take.
2. A function to invoke tools: if the agent decides to take an action, this node will then execute that action.

We will also need to define some edges.
Some of these edges may be conditional.
The reason they are conditional is that based on the output of a node, one of several paths may be taken.
The path that is taken is not known until that node is run (the LLM decides).

1. Conditional Edge: after the agent is called, we should either:
   a. If the agent said to take an action, then the function to invoke tools should be called
   b. If the agent said that it was finished, then it should finish
2. Normal Edge: after the tools are invoked, it should always go back to the agent to decide what to do next

Let's define the nodes, as well as a function to decide how what conditional edge to take.

```typescript
import { FunctionMessage } from "@langchain/core/messages";
import { AgentAction } from "@langchain/core/agents";

// Define the function that determines whether to continue or not
const shouldContinue = (state: { messages: Array<BaseMessage> }) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];
  // If there is no function call, then we finish
  if (
    !("function_call" in lastMessage.additional_kwargs) ||
    !lastMessage.additional_kwargs.function_call
  ) {
    return "end";
  }
  // Otherwise if there is, we continue
  return "continue";
};

// Define the function to execute tools
const _getAction = (state: { messages: Array<BaseMessage> }): AgentAction => {
  const { messages } = state;
  // Based on the continue condition
  // we know the last message involves a function call
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    throw new Error("No messages found.");
  }
  if (!lastMessage.additional_kwargs.function_call) {
    throw new Error("No function call found in message.");
  }
  // We construct an AgentAction from the function_call
  return {
    tool: lastMessage.additional_kwargs.function_call.name,
    toolInput: JSON.stringify(
      lastMessage.additional_kwargs.function_call.arguments
    ),
    log: "",
  };
};

// Define the function that calls the model
const callModel = async (
  state: { messages: Array<BaseMessage> },
  config?: RunnableConfig
) => {
  const { messages } = state;
  const response = await newModel.invoke(messages, config);
  // We return a list, because this will get added to the existing list
  return {
    messages: [response],
  };
};

const callTool = async (
  state: { messages: Array<BaseMessage> },
  config?: RunnableConfig
) => {
  const action = _getAction(state);
  // We call the tool_executor and get back a response
  const response = await toolExecutor.invoke(action, config);
  // We use the response to create a FunctionMessage
  const functionMessage = new FunctionMessage({
    content: response,
    name: action.tool,
  });
  // We return a list, because this will get added to the existing list
  return { messages: [functionMessage] };
};
```

### Define the graph

We can now put it all together and define the graph!

```typescript
import { StateGraph, END } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";

// Define a new graph
const workflow = new StateGraph({
  channels: agentState,
});

// Define the two nodes we will cycle between
workflow.addNode("agent", new RunnableLambda({ func: callModel }));
workflow.addNode("action", new RunnableLambda({ func: callTool }));

// Set the entrypoint as `agent`
// This means that this node is the first one called
workflow.setEntryPoint("agent");

// We now add a conditional edge
workflow.addConditionalEdges(
// First, we define the start node. We use `agent`.
// This means these are the edges taken after the `agent` node is called.
"agent",
// Next, we pass in the function that will determine which node is called next.
shouldContinue,
// Finally we pass in a mapping.
// The keys are strings, and the values are other nodes.
// END is a special node marking that the graph should finish.
// What will happen is we will call `should_continue`, and then the output of that
// will be matched against the keys in this mapping.
// Based on which one it matches, that node will then be called.
{
  // If `tools`, then we call the tool node.
  continue: "action",
  // Otherwise we finish.
  end: END
}
);

// We now add a normal edge from `tools` to `agent`.
// This means that after `tools` is called, `agent` node is called next.
workflow.addEdge("action", "agent");

// Finally, we compile it!
// This compiles it into a LangChain Runnable,
// meaning you can use it as you would any other runnable
const app = workflow.compile();
```

### Use it!

We can now use it!
This now exposes the [same interface](https://js.langchain.com/docs/expression_language/) as all other LangChain runnables.
This runnable accepts a list of messages.

```typescript
import { HumanMessage } from "@langchain/core/messages";

const inputs = {
  messages: [new HumanMessage("what is the weather in sf")]
}
const result = await app.invoke(inputs);
```

See a LangSmith trace of this run [here](https://smith.langchain.com/public/2562d46e-da94-4c9d-9b14-3759a26aec9b/r).

This may take a little bit - it's making a few calls behind the scenes.
In order to start seeing some intermediate results as they happen, we can use streaming - see below for more information on that.

## Streaming

LangGraph has support for several different types of streaming.

### Streaming Node Output

One of the benefits of using LangGraph is that it is easy to stream output as it's produced by each node.

```typescript
const inputs = {
  messages: [new HumanMessage("what is the weather in sf")]
};
for await (const output of await app.stream(inputs)) {
  console.log("output", output);
  console.log("-----\n");
}
```

See a LangSmith trace of this run [here](https://smith.langchain.com/public/9afacb13-b9dc-416e-abbe-6ed2a0811afe/r).

## When to Use

When should you use this versus [LangChain Expression Language](https://js.langchain.com/docs/expression_language/)?

If you need cycles.

Langchain Expression Language allows you to easily define chains (DAGs) but does not have a good mechanism for adding in cycles.
`langgraph` adds that syntax.

## Examples

### ChatAgentExecutor: with function calling

This agent executor takes a list of messages as input and outputs a list of messages. 
All agent state is represented as a list of messages.
This specifically uses OpenAI function calling.
This is recommended agent executor for newer chat based models that support function calling.

- [Getting Started Notebook](https://github.com/langchain-ai/langgraphjs/blob/main/examples/chat_agent_executor_with_function_calling/base.ipynb): Walks through creating this type of executor from scratch

### AgentExecutor

This agent executor uses existing LangChain agents.

- [Getting Started Notebook](https://github.com/langchain-ai/langgraphjs/blob/main/examples/agent_executor/base.ipynb): Walks through creating this type of executor from scratch

### Multi-agent Examples

- [Multi-agent collaboration](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/multi-agent-collaboration.ipynb): how to create two agents that work together to accomplish a task
- [Multi-agent with supervisor](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/agent_supervisor.ipynb): how to orchestrate individual agents by using an LLM as a "supervisor" to distribute work
- [Hierarchical agent teams](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/hierarchical_agent_teams.ipynb): how to orchestrate "teams" of agents as nested graphs that can collaborate to solve a problem

## Documentation

There are only a few new APIs to use.

### StateGraph

The main entrypoint is `StateGraph`.

```typescript
import { StateGraph } from "@langchain/langgraph";
```

This class is responsible for constructing the graph.
It exposes an interface inspired by [NetworkX](https://networkx.org/documentation/latest/).
This graph is parameterized by a state object that it passes around to each node.


#### `constructor`

```typescript
interface StateGraphArgs<T = any> {
  channels: Record<
    string,
    {
      value: BinaryOperator<T> | null;
      default?: () => T;
    }
  >;
}

class StateGraph<T> extends Graph {
  constructor(fields: StateGraphArgs<T>) {}
```

When constructing the graph, you need to pass in a schema for a state.
Each node then returns operations to update that state.
These operations can either SET specific attributes on the state (e.g. overwrite the existing values) or ADD to the existing attribute.
Whether to set or add is denoted by annotating the state object you construct the graph with.


Let's take a look at an example:

```typescript
import { BaseMessage } from "@langchain/core/messages";

const schema = {
  input: {
    value: null,
  },
  agentOutcome: {
    value: null,
  },
  steps: {
    value: (x: Array<BaseMessage>, y: Array<BaseMessage>) => x.concat(y),
    default: () => [],
  },
};
```

We can then use this like:

```typescript
// Initialize the StateGraph with this state
const graph = new StateGraph({ channels: schema })
// Create nodes and edges
...
// Compile the graph
const app = graph.compile()

// The inputs should be an object, because the schema is an object
const inputs = {
   // Let's assume this the input
   input: "hi"
   // Let's assume agent_outcome is set by the graph as some point
   // It doesn't need to be provided, and it will be null by default
}
```

### `.addNode`

```typescript
addNode(key: string, action: RunnableLike<RunInput, RunOutput>): void
```

This method adds a node to the graph.
It takes two arguments:

- `key`: A string representing the name of the node. This must be unique.
- `action`: The action to take when this node is called. This should either be a function or a runnable.

### `.addEdge`

```typescript
addEdge(startKey: string, endKey: string): void
```

Creates an edge from one node to the next.
This means that output of the first node will be passed to the next node.
It takes two arguments.

- `startKey`: A string representing the name of the start node. This key must have already been registered in the graph.
- `endKey`: A string representing the name of the end node. This key must have already been registered in the graph.

### `.addConditionalEdges`

```typescript
addConditionalEdges(
  startKey: string,
  condition: CallableFunction,
  conditionalEdgeMapping: Record<string, string>
): void
```

This method adds conditional edges.
What this means is that only one of the downstream edges will be taken, and which one that is depends on the results of the start node.
This takes three arguments:

- `startKey`: A string representing the name of the start node. This key must have already been registered in the graph.
- `condition`: A function to call to decide what to do next. The input will be the output of the start node. It should return a string that is present in `conditionalEdgeMapping` and represents the edge to take.
- `conditionalEdgeMapping`: A mapping of string to string. The keys should be strings that may be returned by `condition`. The values should be the downstream node to call if that condition is returned.

### `.setEntryPoint`

```typescript
setEntryPoint(key: string): void
```

The entrypoint to the graph.
This is the node that is first called.
It only takes one argument:

- `key`: The name of the node that should be called first.

### `.setFinishPoint`

```typescript
setFinishPoint(key: string): void
```

This is the exit point of the graph.
When this node is called, the results will be the final result from the graph.
It only has one argument:

- `key`: The name of the node that, when called, will return the results of calling it as the final output

Note: This does not need to be called if at any point you previously created an edge (conditional or normal) to `END`

### `END`

```typescript
import { END } from "@langchain/langgraph";
```

This is a special node representing the end of the graph.
This means that anything passed to this node will be the final output of the graph.
It can be used in two places:

- As the `endKey` in `addEdge`
- As a value in `conditionalEdgeMapping` as passed to `addConditionalEdges`

## When to Use

When should you use this versus [LangChain Expression Language](https://js.langchain.com/docs/expression_language/)?

If you need cycles.

Langchain Expression Language allows you to easily define chains (DAGs) but does not have a good mechanism for adding in cycles.
`langgraph` adds that syntax.

## Examples

### AgentExecutor

See the above Quick Start for an example of re-creating the LangChain [`AgentExecutor`](https://js.langchain.com/docs/modules/agents/concepts#agentexecutor) class.

### Forced Function Calling

One simple modification of the above Graph is to modify it such that a certain tool is always called first.
This can be useful if you want to enforce a certain tool is called, but still want to enable agentic behavior after the fact.

Assuming you have done the above Quick Start, you can build off it like:

#### Define the first tool call

Here, we manually define the first tool call that we will make.
Notice that it does that same thing as `agent` would have done (adds the `agentOutcome` key).
This is so that we can easily plug it in.

```typescript
import { AgentStep, AgentAction, AgentFinish } from "@langchain/core/agents";

// Define the data type that the agent will return.
type AgentData = {
  input: string;
  steps: Array<AgentStep>;
  agentOutcome?: AgentAction | AgentFinish;
};

const firstAgent = (inputs: AgentData) => {
  const newInputs = inputs;
  const action = {
    // We force call this tool
    tool: "tavily_search_results_json",
    // We just pass in the `input` key to this tool
    toolInput: newInputs.input,
    log: ""
  };
  newInputs.agentOutcome = action;
  return newInputs;
};
```

#### Create the graph

We can now create a new graph with this new node

```typescript
const workflow = new Graph();

// Add the same nodes as before, plus this "first agent"
workflow.addNode("firstAgent", firstAgent);
workflow.addNode("agent", agent);
workflow.addNode("tools", executeTools);

// We now set the entry point to be this first agent
workflow.setEntryPoint("firstAgent");

// We define the same edges as before
workflow.addConditionalEdges("agent", shouldContinue, {
  continue: "tools",
  exit: END
});
workflow.addEdge("tools", "agent");

// We also define a new edge, from the "first agent" to the tools node
// This is so that we can call the tool
workflow.addEdge("firstAgent", "tools");

// We now compile the graph as before
const chain = workflow.compile();
```

#### Use it!

We can now use it as before!
Depending on whether or not the first tool call is actually useful, this may save you an LLM call or two.

```typescript
const result = await chain.invoke({
  input: "what is the weather in sf",
  steps: []
});
```

You can see a LangSmith trace of this chain [here](https://smith.langchain.com/public/2e0a089f-8c05-405a-8404-b0a60b79a84a/r).
