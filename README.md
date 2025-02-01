# 🦜🕸️LangGraph.js

[![Docs](https://img.shields.io/badge/docs-latest-blue)](https://langchain-ai.github.io/langgraphjs/)
![Version](https://img.shields.io/npm/v/@langchain/langgraph?logo=npm)  
[![Downloads](https://img.shields.io/npm/dm/@langchain/langgraph)](https://www.npmjs.com/package/@langchain/langgraph)
[![Open Issues](https://img.shields.io/github/issues-raw/langchain-ai/langgraphjs)](https://github.com/langchain-ai/langgraphjs/issues)

⚡ Building language agents as graphs ⚡

> [!NOTE]
> Looking for the Python version? See the [Python repo](https://github.com/langchain-ai/langgraph) and the [Python docs](https://langchain-ai.github.io/langgraph/).

## Overview

[LangGraph](https://langchain-ai.github.io/langgraphjs/) is a library for building
stateful, multi-actor applications with LLMs, used to create agent and multi-agent
workflows. Check out an introductory tutorial [here](https://langchain-ai.github.io/langgraphjs/tutorials/quickstart/).


LangGraph is inspired by [Pregel](https://research.google/pubs/pub37252/) and [Apache Beam](https://beam.apache.org/). The public interface draws inspiration from [NetworkX](https://networkx.org/documentation/latest/). LangGraph is built by LangChain Inc, the creators of LangChain, but can be used without LangChain.

### Why use LangGraph?

LangGraph powers [production-grade agents](https://www.langchain.com/built-with-langgraph), trusted by Linkedin, Uber, Klarna, GitLab, and many more. LangGraph provides fine-grained control over both the flow and state of your agent applications. It implements a central [persistence layer](https://langchain-ai.github.io/langgraphjs/concepts/persistence/), enabling features that are common to most agent architectures:

- **Memory**: LangGraph persists arbitrary aspects of your application's state,
supporting memory of conversations and other updates within and across user
interactions;
- **Human-in-the-loop**: Because state is checkpointed, execution can be interrupted
and resumed, allowing for decisions, validation, and corrections at key stages via
human input.

Standardizing these components allows individuals and teams to focus on the behavior
of their agent, instead of its supporting infrastructure.

Through [LangGraph Platform](#langgraph-platform), LangGraph also provides tooling for
the development, deployment, debugging, and monitoring of your applications.

LangGraph integrates seamlessly with
[LangChain](https://js.langchain.com/docs/introduction/) and
[LangSmith](https://docs.smith.langchain.com/) (but does not require them).

To learn more about LangGraph, check out our first LangChain Academy
course, *Introduction to LangGraph*, available for free
[here](https://academy.langchain.com/courses/intro-to-langgraph).

### LangGraph Platform

[LangGraph Platform](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_platform) is infrastructure for deploying LangGraph agents. It is a commercial solution for deploying agentic applications to production, built on the open-source LangGraph framework. The LangGraph Platform consists of several components that work together to support the development, deployment, debugging, and monitoring of LangGraph applications: [LangGraph Server](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_server) (APIs), [LangGraph SDKs](https://langchain-ai.github.io/langgraphjs/concepts/sdk) (clients for the APIs), [LangGraph CLI](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_cli) (command line tool for building the server), and [LangGraph Studio](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_studio) (UI/debugger).

See deployment options [here](https://langchain-ai.github.io/langgraphjs/concepts/deployment_options/)
(includes a free tier).

Here are some common issues that arise in complex deployments, which LangGraph Platform addresses:

- **Streaming support**: LangGraph Server provides [multiple streaming modes](https://langchain-ai.github.io/langgraphjs/concepts/streaming) optimized for various application needs
- **Background runs**: Runs agents asynchronously in the background
- **Support for long running agents**: Infrastructure that can handle long running processes
- **[Double texting](https://langchain-ai.github.io/langgraphjs/concepts/double_texting)**: Handle the case where you get two messages from the user before the agent can respond
- **Handle burstiness**: Task queue for ensuring requests are handled consistently without loss, even under heavy loads

## Installation

```shell
npm install @langchain/langgraph @langchain/core
```

## Example

Let's build a tool-calling [ReAct-style](https://langchain-ai.github.io/langgraphjs/concepts/agentic_concepts/#react-implementation) agent that uses a search tool!

```shell
npm install @langchain/anthropic zod
```

```shell
export ANTHROPIC_API_KEY=sk-...
```

Optionally, we can set up [LangSmith](https://docs.smith.langchain.com/) for best-in-class observability.

```shell
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=lsv2_sk_...
```

The simplest way to create a tool-calling agent in LangGraph is to use [`createReactAgent`](https://langchain-ai.github.io/langgraphjs/reference/functions/langgraph_prebuilt.createReactAgent.html):

<details open>
  <summary>High-level implementation</summary>

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";

import { z } from "zod";

// Define the tools for the agent to use
const search = tool(async ({ query }) => {
  // This is a placeholder, but don't tell the LLM that...
  if (query.toLowerCase().includes("sf") || query.toLowerCase().includes("san francisco")) {
    return "It's 60 degrees and foggy."
  }
  return "It's 90 degrees and sunny."
}, {
  name: "search",
  description: "Call to surf the web.",
  schema: z.object({
    query: z.string().describe("The query to use in your search."),
  }),
});

const tools = [search];
const model =  new ChatAnthropic({
  model: "claude-3-5-sonnet-latest"
});

// Initialize memory to persist state between graph runs
const checkpointer = new MemorySaver();

const app = createReactAgent({
  llm: model,
  tools,
  checkpointSaver: checkpointer,
});

// Use the agent
const result = await app.invoke(
  {
    messages: [{
      role: "user",
      content: "what is the weather in sf"
    }]
  },
  { configurable: { thread_id: 42 } }
);
console.log(result.messages.at(-1)?.content);
```
```
"Based on the search results, it's currently 60 degrees Fahrenheit and foggy in San Francisco, which is quite typical weather for the city."
```

Now when we pass the same <code>"thread_id"</code>, the conversation context is retained via the saved state (i.e. stored list of messages)

```ts
const followup = await app.invoke(
  {
    messages: [{
      role: "user",
      content: "what about ny"
    }]
  },
  { configurable: { thread_id: 42 } }
);

console.log(followup.messages.at(-1)?.content);
```

```
"According to the search results, it's currently 90 degrees Fahrenheit and sunny in New York City. That's quite a warm day for New York!"
```
</details>

> [!TIP]
> LangGraph is a **low-level** framework that allows you to implement any custom agent
architectures. Click on the low-level implementation below to see how to implement a
tool-calling agent from scratch.

<details>
<summary>Low-level implementation</summary>

```ts
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";
import { StateGraph } from "@langchain/langgraph";
import { MemorySaver, Annotation, messagesStateReducer } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// Define the graph state
// See here for more info: https://langchain-ai.github.io/langgraphjs/how-tos/define-state/
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    // `messagesStateReducer` function defines how `messages` state key should be updated
    // (in this case it appends new messages to the list and overwrites messages with the same ID)
    reducer: messagesStateReducer,
  }),
});

// Define the tools for the agent to use
const weatherTool = tool(async ({ query }) => {
  // This is a placeholder for the actual implementation
  if (query.toLowerCase().includes("sf") || query.toLowerCase().includes("san francisco")) {
    return "It's 60 degrees and foggy."
  }
  return "It's 90 degrees and sunny."
}, {
  name: "weather",
  description:
    "Call to get the current weather for a location.",
  schema: z.object({
    query: z.string().describe("The query to use in your search."),
  }),
});

const tools = [weatherTool];
const toolNode = new ToolNode(tools);

const model = new ChatAnthropic({
  model: "claude-3-5-sonnet-20240620",
  temperature: 0,
}).bindTools(tools);

// Define the function that determines whether to continue or not
// We can extract the state typing via `StateAnnotation.State`
function shouldContinue(state: typeof StateAnnotation.State) {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1] as AIMessage;

  // If the LLM makes a tool call, then we route to the "tools" node
  if (lastMessage.tool_calls?.length) {
    return "tools";
  }
  // Otherwise, we stop (reply to the user)
  return "__end__";
}

// Define the function that calls the model
async function callModel(state: typeof StateAnnotation.State) {
  const messages = state.messages;
  const response = await model.invoke(messages);

  // We return a list, because this will get added to the existing list
  return { messages: [response] };
}

// Define a new graph
const workflow = new StateGraph(StateAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
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

<b>Step-by-step Breakdown</b>:

<details>
<summary>Initialize the model and tools.</summary>
<ul>
  <li>
    We use <code>ChatAnthropic</code> as our LLM. <strong>NOTE:</strong> we need to make sure the model knows that it has these tools available to call. We can do this by converting the LangChain tools into the format for OpenAI tool calling using the <code>.bindTools()</code> method.
  </li>
  <li>
    We define the tools we want to use - a search tool in our case. It is really easy to create your own tools - see documentation here on how to do that <a href="https://js.langchain.com/docs/how_to/custom_tools">here</a>.
  </li>
</ul>
</details>

<details>
<summary>Initialize graph with state.</summary>

<ul>
    <li>We initialize the graph (<code>StateGraph</code>) by passing state schema with a reducer that defines how the state should be updated. In our case, we want to append new messages to the list and overwrite messages with the same ID, so we use the prebuilt <code>messagesStateReducer</code>.</li>
</ul>
</details>

<details>
<summary>Define graph nodes.</summary>

There are two main nodes we need:

<ul>
    <li>The <code>agent</code> node: responsible for deciding what (if any) actions to take.</li>
    <li>The <code>tools</code> node that invokes tools: if the agent decides to take an action, this node will then execute that action.</li>
</ul>
</details>

<details>
<summary>Define entry point and graph edges.</summary>

First, we need to set the entry point for graph execution - <code>agent</code> node.

Then we define one normal and one conditional edge. Conditional edge means that the destination depends on the contents of the graph's state. In our case, the destination is not known until the agent (LLM) decides.

<ul>
  <li>Conditional edge: after the agent is called, we should either:
    <ul>
      <li>a. Run tools if the agent said to take an action, OR</li>
      <li>b. Finish (respond to the user) if the agent did not ask to run tools</li>
    </ul>
  </li>
  <li>Normal edge: after the tools are invoked, the graph should always return to the agent to decide what to do next</li>
</ul>
</details>

<details>
<summary>Compile the graph.</summary>

<ul>
  <li>
    When we compile the graph, we turn it into a LangChain 
    <a href="https://js.langchain.com/docs/concepts/runnables">Runnable</a>, 
    which automatically enables calling <code>.invoke()</code>, <code>.stream()</code> and <code>.batch()</code> 
    with your inputs
  </li>
  <li>
    We can also optionally pass checkpointer object for persisting state between graph runs, and enabling memory, 
    human-in-the-loop workflows, time travel and more. In our case we use <code>MemorySaver</code> - 
    a simple in-memory checkpointer
  </li>
</ul>
</details>

<details>
<summary>Execute the graph.</summary>

<ol>
  <li>LangGraph adds the input message to the internal state, then passes the state to the entrypoint node, <code>"agent"</code>.</li>
  <li>The <code>"agent"</code> node executes, invoking the chat model.</li>
  <li>The chat model returns an <code>AIMessage</code>. LangGraph adds this to the state.</li>
  <li>Graph cycles the following steps until there are no more <code>tool_calls</code> on <code>AIMessage</code>:
    <ul>
      <li>If <code>AIMessage</code> has <code>tool_calls</code>, <code>"tools"</code> node executes</li>
      <li>The <code>"agent"</code> node executes again and returns <code>AIMessage</code></li>
    </ul>
  </li>
  <li>Execution progresses to the special <code>END</code> value and outputs the final state. And as a result, we get a list of all our chat messages as output.</li>
</ol>
</details>

</details>

## Documentation

* [Tutorials](https://langchain-ai.github.io/langgraphjs/tutorials/): Learn to build with LangGraph through guided examples.
* [How-to Guides](https://langchain-ai.github.io/langgraphjs/how-tos/): Accomplish specific things within LangGraph, from streaming, to adding memory & persistence, to common design patterns (branching, subgraphs, etc.), these are the place to go if you want to copy and run a specific code snippet.
* [Conceptual Guides](https://langchain-ai.github.io/langgraphjs/concepts/high_level/): In-depth explanations of the key concepts and principles behind LangGraph, such as nodes, edges, state and more.
* [API Reference](https://langchain-ai.github.io/langgraphjs/reference/): Review important classes and methods, simple examples of how to use the graph and checkpointing APIs, higher-level prebuilt components and more.
* [LangGraph Platform](https://langchain-ai.github.io/langgraphjs/concepts/#langgraph-platform): LangGraph Platform is a commercial solution for deploying agentic applications in production, built on the open-source LangGraph framework.

## Resources

* [Built with LangGraph](https://www.langchain.com/built-with-langgraph): Hear how industry leaders use LangGraph to ship powerful, production-ready AI applications.

## Contributing

For more information on how to contribute, see [here](https://github.com/langchain-ai/langgraphjs/blob/main/CONTRIBUTING.md).
