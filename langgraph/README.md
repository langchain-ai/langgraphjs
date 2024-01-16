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

### Define the LangChain Agent

This is the LangChain agent. 
Crucially, this agent is just responsible for deciding what actions to take.
For more information on what is happening here, please see [this documentation](https://js.langchain.com/docs/modules/agents/quick_start).

```typescript
import { pull } from "langchain/hub";
import { createOpenAIFunctionsAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const tools = [new TavilySearchResults({ maxResults: 1 })];

// Get the prompt to use - you can modify this!
const prompt = await pull<ChatPromptTemplate>(
  "hwchase17/openai-functions-agent"
);

// Choose the LLM that will drive the agent
const llm = new ChatOpenAI({
  modelName: "gpt-4-1106-preview",
  temperature: 0
});

// Construct the OpenAI Functions agent
const agentRunnable = await createOpenAIFunctionsAgent({
  llm,
  tools,
  prompt
});
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
import { RunnablePassthrough } from "@langchain/core/runnables";
import { AgentAction, AgentFinish, AgentStep } from "@langchain/core/agents";
import { Tool } from "@langchain/core/tools";

// Define the agent
// Note that here, we are using `.assign` to add the output of the agent to the object
// This object will be returned from the node
// The reason we don't want to return just the result of `agentRunnable` from this node is
// that we want to continue passing around all the other inputs
const agent = RunnablePassthrough.assign({
  agentOutcome: agentRunnable
});

// Define the data type that the agent will return.
type AgentData = {
  input: string;
  steps: Array<AgentStep>;
  agentOutcome?: AgentAction | AgentFinish;
};

// Define the function to execute tools
const executeTools = async (data: AgentData) => {
  const newData = { ...data };
  if (!newData.agentOutcome || "returnValues" in newData.agentOutcome) {
    throw new Error("Can not execute tools on a finished agent");
  }
  // Get the most recent agentOutcome - this is the key added in the `agent` above
  const agentAction = newData.agentOutcome;
  delete newData.agentOutcome; // Remove the agentOutcome from data

  // Assuming 'tools' is an array of Tool, we convert it to a map for easy access
  const toolsMap: { [key: string]: Tool } = {};
  for (const tool of tools) {
    toolsMap[tool.name] = tool;
  }

  // Get the tool to use
  const toolToUse: Tool = toolsMap[agentAction.tool];

  // Call that tool on the input
  const observation = await toolToUse.invoke(agentAction.toolInput);

  // We now add in the action and the observation to the `steps` list
  // This is the list of all previous actions taken and their output
  if (!newData.steps) {
    newData.steps = [];
  }
  newData.steps.push({ action: agentAction, observation });

  return newData;
};

// Define logic that will be used to determine which conditional edge to go down
const shouldContinue = (data: AgentData): string => {
  // If the agent outcome is an AgentFinish, then we return `exit` string
  // This will be used when setting up the graph to define the flow
  if (!data.agentOutcome || "returnValues" in data.agentOutcome) {
    return "exit";
  }
  // Otherwise, an AgentAction is returned
  // Here we return `continue` string
  // This will be used when setting up the graph to define the flow
  return "continue";
};
```

### Define the graph

We can now put it all together and define the graph!

```typescript
import { END, Graph } from "@langchain/langgraph";

const workflow = new Graph();

// Add the agent node, we give it name `agent` which we will use later
workflow.addNode("agent", agent);
// Add the tools node, we give it name `tools` which we will use later
workflow.addNode("tools", executeTools);

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
    continue: "tools",
    // Otherwise we finish.
    exit: END
  }
);

//  We now add a normal edge from `tools` to `agent`.
// This means that after `tools` is called, `agent` node is called next.
workflow.addEdge("tools", "agent");

// Finally, we compile it!
// This compiles it into a LangChain Runnable,
// meaning you can use it as you would any other runnable
const chain = workflow.compile();
```

### Use it!

We can now use it!
This now exposes the [same interface](https://js.langchain.com/docs/expression_language/) as all other LangChain runnables

```typescript
const result = await chain.invoke({
  input: "what is the weather in sf",
  steps: []
});
```

You can see a LangSmith trace of this chain [here](https://smith.langchain.com/public/c17c1263-e97b-4bd1-bbb0-ed74872b2c91/r).

## Documentation

There are only a few new APIs to use.

The main new class is `Graph`.

```typescript
import { Graph } from "@langchain/langgraph";
```

This class is responsible for constructing the graph.
It exposes an interface inspired by [NetworkX](https://networkx.org/documentation/latest/).

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
