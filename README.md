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
