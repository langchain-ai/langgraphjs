# 🦜🕸️LangGraph.js

[![Docs](https://img.shields.io/badge/docs-latest-blue)](https://langchain-ai.github.io/langgraphjs/)
![Version](https://img.shields.io/npm/v/@langchain/langgraph?logo=npm)
[![Downloads](https://img.shields.io/npm/dm/@langchain/langgraph)](https://www.npmjs.com/package/@langchain/langgraph)
[![Open Issues](https://img.shields.io/github/issues-raw/langchain-ai/langgraphjs)](https://github.com/langchain-ai/langgraphjs/issues)
[![](https://dcbadge.vercel.app/api/server/6adMQxSpJS?compact=true&style=flat)](https://discord.com/channels/1038097195422978059/1170024642245832774)

⚡ Building language agents as graphs ⚡

???+ note "JS version :fontawesome-brands-square-js:"

    Looking for the Python version? Click [:material-language-python: here](https://github.com/langchain-ai/langgraph) ([:simple-readme: docs](https://langchain-ai.github.io/langgraph/)).

## Overview

Suppose you're building a customer support assistant. You want your assistant to be able to:

1. Use tools to respond to questions
2. Connect with a human if needed
3. Be able to pause the process indefinitely and resume whenever the human responds

LangGraph makes this all easy. First install:

```bash
npm install @langchain/langgraph
```

Then define your assistant:

```typescript
import { ToolNode } from "@langchain/langgraph/prebuilt"

import { TavilySearchResults } from "@langchain/community/tools/tavily_search"
import { ChatAnthropic } from "@langchain/anthropic"
import { AIMessage, BaseMessage } from "@langchain/core/messages";


import { SqliteSaver } from "@langchain/langgraph/checkpoint/sqlite"

import { START, END, MessageGraph } from "@langchain/langgraph"



// Define the function that determines whether to continue or not
function shouldContinue(messages: BaseMessage[]): "action" | typeof END {
  const lastMessage = messages[messages.length - 1];

  // If there is no function call, then we finish
  if (!(lastMessage as AIMessage)?.tool_calls) {
    return END;

  } else {
    return "action";

  }
}

// Define a new graph

const tools = [new TavilySearchResults({ maxResults: 1 })];

const model = new ChatAnthropic({ model: "claude-3-haiku-20240307" }).bindTools(tools);

const workflow = new MessageGraph()
  .addNode("agent", model)
  .addNode("action", new ToolNode<BaseMessage[]>(tools));


workflow.addEdge(START, "agent");
// Conditional agent -> action OR agent -> END
workflow.addConditionalEdges("agent", shouldContinue);
// Always transition `action` -> `agent`
workflow.addEdge("action", "agent");


const memory = SqliteSaver.fromConnString(":memory:"); // Here we only save in-memory

// Setting the interrupt means that any time an action is called, the machine will stop
const app = workflow.compile({ checkpointer: memory, interruptBefore: ["action"] });
```

Now, run the graph:

```typescript
// Run the graph
const thread = { configurable: { thread_id: "4" } };
for await (const event of await app.stream(
  [["user", "what is the weather in sf currently"]],
  { ...thread, streamMode: "values" }
)) {
  for (const v of event.values()) {
    console.log(v);
  }
}
```

We configured the graph to **wait** before executing the `action`. The `SqliteSaver` persists the state. Resume at any time.

```typescript
for await (const event of await app.stream(null, {
  ...thread,
  streamMode: "values",
})) {
  for (const v of event.values()) {
    console.log(v);
  }
}
```

The graph orchestrates everything:

- The `MessageGraph` contains the agent's "Memory"
- Conditional edges enable dynamic routing between the chatbot, tools, and the user
- Persistence makes it easy to stop, resume, and even rewind for full control over your application

With LangGraph, you can build complex, stateful agents without getting bogged down in manual state and interrupt management. Just define your nodes, edges, and state schema - and let the graph take care of the rest.

## Tutorials

Consult the [Tutorials](tutorials/index.md) to learn more about building with LangGraph, including advanced use cases.

## How-To Guides

Check out the [How-To Guides](how-tos/index.md) for instructions on handling common tasks with LangGraph.

## Reference

For documentation on the core APIs, check out the [Reference](reference/index.html) docs.

## Conceptual Guides

Once you've learned the basics, if you want to further understand LangGraph's core abstractions, check out the [Conceptual Guides](./concepts/index.md).

## Why LangGraph?

LangGraph is framework agnostic (each node is a regular JavaScript function). It extends the core Runnable API (shared interface for streaming, async, and batch calls) to make it easy to:

- Seamless state management across multiple turns of conversation or tool usage
- The ability to flexibly route between nodes based on dynamic criteria 
- Smooth switching between LLMs and human intervention  
- Persistence for long-running, multi-session applications

If you're building a straightforward DAG, Runnables are a great fit. But for more complex, stateful applications with nonlinear flows, LangGraph is the perfect tool for the job.