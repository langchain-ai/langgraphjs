# Build your first agent - Introduction

In this comprehensive tutorial, we will build an AI support chatbot using LangGraph.js that can:

- Answer common questions by searching the web
- Maintain conversation state across calls
- Route complex queries to a human for review
- Use custom state to control its behavior
- Rewind and explore alternative conversation paths

We'll start with a basic chatbot and progressively add more sophisticated capabilities, introducing key LangGraph concepts along the way. Later, we will learn how to iterate on an agent graph using Studio and deploy it using LangGraph Cloud.

There's a lot of ground to cover, but don't worry! We'll take it step by step across 7 parts. Each part will introduce a single concept that helps improve the chatbot's capabilities. At the end you should feel comfortable building, debugging, iterating on, and deploying an AI agent of your own. Here's an overview of what we'll cover:

- [**Setup**](/first-agent/0-setup.md) _(You are here)_: Set up your development environment, dependencies, and services needed to build the chatbot.
- [**Part 1: Create a chatbot**](/first-agent/1-create-chatbot.md): Build a basic chatbot that can answer questions using Anthropic's LLM.
- [**Part 2: Add search Retrieval-Augmented Generation (RAG)**](/first-agent/2-rag-search.md): Provide the chatbot with a tool to search the web using Tavily.
- [**Part 3: Add persistent state**](/first-agent/3-persistent-state.md): Add memory to the chatbot so it can continue past conversations.
- [**Part 4: Add human-in-the-loop**](/first-agent/4-human-loop.md): Route complex queries to a human for review.
- [**Part 5: Time-travel debugging**](/first-agent/5-time-travel-debugging.md): Use the persisted state to rewind and debug or explore alternative conversation paths.
- [**Part 6: Iterate using Studio**](/first-agent/6-studio.md): Setup Studio to iterate and debug the agent using a graphical interface.
- [**Part 7: Deploy to LangGraph Cloud**](/first-agent/7-deploy.md): Deploy the agent to LangGraph Cloud and interact with it over the web.

## Prerequisites

To complete this tutorial, you will need to have a computer set up with Node.js 18 or later. You can download Node.js from the [official website](https://nodejs.org/).

You will also need a basic understanding of JavaScript and TypeScript, and should be familiar with the command line.

LangGraph makes it easy to work with a variety of tools and services to build AI agents. In this tutorial, we will use the following:

- [Anthropic API](https://console.anthropic.com/) will be used for the base Large Language Model (LLM) that powers the chatbot.
- [Tavily's Search API](https://tavily.com/) will be used as a tool that enables the agent to search the web.

To complete this tutorial, you will need to sign up and get an API key for both services.

## Setup

Once you've got NodeJS installed and have signed up for Tavily and Anthropic, you are ready to get the project setup.

First, run the follow commands to create a new directory for your project and navigate to it in your terminal.

```bash
mkdir langgraph-chatbot
cd langgraph-chatbot
```

### Environment variables

Next, create a `.env` file in the root of your project and add the API keys you received from Anthropic and Tavily:

```
#.env
ANTHROPIC_API_KEY=your-Anthropic-key-here
TAVILY_API_KEY=your-Tavily-key-here
```

While we're at it, let's make sure the environment variables defined in the `.env` file are available to our project. We can do this by installing the `dotenv` package:

```bash
npm install dotenv
```

Now we need to make sure dotenv loads the environment variables from the `.env` file. To do this, create a new file called `chatbot.ts` and add the following lines at the top of the:

```ts
// chatbot
import "dotenv/config";
```

This will load the environment variables from the `.env` file onto the `process.env` object when the project starts. To verify it's working, let's log the environment variables to the console.
Add the following lines to the end of the `chatbot.ts` file:

```ts
console.log(process.env.ANTHROPIC_API_KEY);
console.log(process.env.TAVILY_API_KEY);
```

Now let's run the project using `tsx`, a tool that lets us run TypeScript code without first compiling it to JS. Use the following command:

```bash
npx tsx chatbot.ts
```

You should see the API keys you added to your `.env` file printed to the console.

### Install dependencies

You'll also need to install a few dependencies to create an agent:

- **@langchain/core** provides the core functionality of Langchain that LangGraph depends on
- **@langchain/langgraph** contains the building blocks used to assemble an agent
- **@langchain/anthropic** enable you to use Anthropic's LLMs in LangGraph
- **@langchain/community** contains the Tavily search tool that will be used by the agent

Let's do that using the Node Package Manager (npm). Run the following command in your terminal:

```bash
npm install @langchain/langgraph @langchain/anthropic @langchain/community
```

### (Encouraged) Set up tracing with LangSmith

Setting up up LangSmith is optional, but it makes it a lot easier to understand what's going on "under the hood."

To use [LangSmith](https://smith.langchain.com/) you'll need to sign up and get an API key. Once you have an API key, add the following to your `.env` file:

```
LANGCHAIN_API_KEY=your-LangSmith-key-here
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT="LangGraph Tutorial"
LANCHAIN_CALLBACKS_BACKGROUND=true
```

At this point, you should be ready to start building your first agent. When you're ready, move on to [part 1: create a chatbot](/first-agent/1-create-chatbot.md).
