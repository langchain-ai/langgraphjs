# Deployment

To deploy your LangGraph agent, create and configure a LangGraph app. This setup supports both local development and production deployments.

Features: 

* 🖥️ Local server for development
* 🧩 Studio Web UI for visual debugging
* ☁️ Cloud and 🔧 self-hosted deployment options
* 📊 LangSmith integration for tracing and observability

!!! info "Requirements" 

    - ✅ You **must** have a [LangSmith account](https://www.langchain.com/langsmith). You can sign up for **free** and get started with the free tier.

## Create a LangGraph app

```bash
npm install -g create-langgraph
create-langgraph path/to/your/app
```

Follow the prompts and select `New LangGraph Project`. This will create an empty LangGraph project. You can modify it by replacing the code in `src/agent/graph.ts` with your agent code. For example:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async (input: { city: string }) => {
    return `It's always sunny in ${input.city}!`;
  },
  {
    name: "getWeather",
    schema: z.object({
      city: z.string().describe("The city to get the weather for"),
    }),
    description: "Get weather for a given city.",
  }
);

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
// make sure to export the graph that will be used in the LangGraph API server
// highlight-next-line
export const graph = createReactAgent({
  llm,
  tools: [getWeather],
  prompt: "You are a helpful assistant"
})
```

### Install dependencies

In the root of your new LangGraph app, install the dependencies:

```shell
yarn
# install these to use initChatModel with Anthropic
yarn add langchain
yarn add @langchain/anthropic
```

### Create an `.env` file

You will find a `.env.example` in the root of your new LangGraph app. Create
a `.env` file in the root of your new LangGraph app and copy the contents of the `.env.example` file into it, filling in the necessary API keys:

```bash
LANGSMITH_API_KEY=lsv2...
ANTHROPIC_API_KEY=sk-
```

## Launch LangGraph server locally

```shell
npx @langchain/langgraph-cli dev
```

This will start up the LangGraph API server locally. If this runs successfully, you should see something like:

>    Welcome to LangGraph.js!
> 
>    - 🚀 API: http://localhost:2024
>     
>    - 🎨 Studio UI: https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024

## LangGraph Studio Web UI

LangGraph Studio Web is a specialized UI that you can connect to LangGraph API server to enable visualization, interaction, and debugging of your application locally. Test your graph in the LangGraph Studio Web UI by visiting the URL provided in the output of the `npx @langchain/langgraph-cli dev` command.

>    - LangGraph Studio Web UI: https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024

## Deployment

Once your LangGraph app is running locally, you can deploy it using LangGraph Cloud or self-hosted options. Refer to the [deployment options guide](https://langchain-ai.github.io/langgraph/tutorials/deployment/) for detailed instructions on all supported deployment models.
