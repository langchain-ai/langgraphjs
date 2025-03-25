# 🤖 LangGraph.js Computer Use Agent (CUA)

> [!TIP]
> Looking for the Python version? [Check out the repo here](https://github.com/langchain-ai/langgraph-cua-py).

> [!WARNING] > **THIS REPO IS A WORK IN PROGRESS AND NOT INTENDED FOR USE YET**

A TypeScript library for creating computer use agent (CUA) systems using [LangGraph.js](https://github.com/langchain-ai/langgraphjs). A CUA is a type of agent which has the ability to interact with a computer to preform tasks.

Short demo video:
<video src="https://github.com/user-attachments/assets/7fd0ab05-fecc-46f5-961b-6624cb254ac2" controls></video>

> [!TIP]
> This demo used the following prompt:
>
> ```
> I want to contribute to the LangGraph.js project. Please find the GitHub repository, and inspect the read me,
> along with some of the issues and open pull requests. Then, report back with a plan of action to contribute.
> ```

This library is built on top of [LangGraph.js](https://github.com/langchain-ai/langgraphjs), a powerful framework for building agent applications, and comes with out-of-box support for [streaming](https://langchain-ai.github.io/langgraph/how-tos/#streaming), [short-term and long-term memory](https://langchain-ai.github.io/langgraph/concepts/memory/) and [human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/).

## Installation

You will need to explicitly install LangGraph, Core, and OpenAI since these are peer dependencies of this package.

```bash
yarn add @langchain/langgraph-cua @langchain/langgraph @langchain/core @langchain/openai
```

## Quickstart

This project by default uses [Scrapybara](https://scrapybara.com/) for accessing a virtual machine to run the agent. To use LangGraph CUA, you'll need both OpenAI and Scrapybara API keys.

```bash
export OPENAI_API_KEY=<your_api_key>
export SCRAPYBARA_API_KEY=<your_api_key>
```

Then, create the graph by importing the `createCua` function from the `@langchain/langgraph-cua` module.

```typescript
import "dotenv/config";
import { createCua } from "@langchain/langgraph-cua";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const cuaGraph = createCua();

// Define the input messages
const messages = [
  new SystemMessage({
    content:
      "You're an advanced AI computer use assistant. The browser you are using " +
      "is already initialized, and visiting google.com.",
  }),
  new HumanMessage({
    content:
      "I want to contribute to the LangGraph.js project. Please find the GitHub repository, and inspect the read me, " +
      "along with some of the issues and open pull requests. Then, report back with a plan of action to contribute.",
  }),
];

async function main() {
  // Stream the graph execution
  const stream = await cuaGraph.stream(
    { messages },
    {
      streamMode: "updates",
    }
  );

  // Process the stream updates
  for await (const update of stream) {
    console.log(update);
  }

  console.log("Done");
}

main().catch(console.error);
```

The above example will invoke the graph, passing in a request for it to do some research into LangGraph.js from the standpoint of a new contributor. The code will log the stream URL, which you can open in your browser to view the CUA stream.

You can find more examples inside the [`examples` directory](./examples/).

## How to customize

The `createCua` function accepts a few configuration parameters. These are the same configuration parameters that the graph accepts, along with `recursionLimit`.

You can either pass these parameters when calling `createCua`, or at runtime when invoking the graph by passing them to the `config` object.

### Configuration Parameters

- `scrapybaraApiKey`: The API key to use for Scrapybara. If not provided, it defaults to reading the `SCRAPYBARA_API_KEY` environment variable.
- `timeoutHours`: The number of hours to keep the virtual machine running before it times out.
- `zdrEnabled`: Whether or not Zero Data Retention is enabled in the user's OpenAI account. If `true`, the agent will not pass the `previous_response_id` to the model, and will always pass it the full message history for each request. If `false`, the agent will pass the `previous_response_id` to the model, and only the latest message in the history will be passed. Default `false`.
- `recursionLimit`: The maximum number of recursive calls the agent can make. Default is 100. This is greater than the standard default of 25 in LangGraph, because computer use agents are expected to take more iterations.
- `authStateId`: The ID of the authentication state. If defined, it will be used to authenticate with Scrapybara. Only applies if 'environment' is set to 'web'.
- `environment`: The environment to use. Default is `web`. Options are `web`, `ubuntu`, and `windows`.

## Auth States

LangGraph CUA integrates with Scrapybara's [auth states API](https://docs.scrapybara.com/auth-states) to persist browser authentication sessions. This allows you to authenticate once (e.g., logging into Amazon) and reuse that session in future runs.

### Using Auth States

Pass an `authStateId` when creating your CUA graph:

```typescript
import { createCua } from "@langgraph/cua";

const cuaGraph = createCua({ authStateId: "<your_auth_state_id>" });
```

The graph stores this ID in the `authenticatedId` state field. If you change the `authStateId` in future runs, the graph will automatically reauthenticate.

### Managing Auth States with Scrapybara SDK

#### Save an Auth State

```typescript
import { ScrapybaraClient } from "scrapybara";

const client = new ScrapybaraClient({ apiKey: "<api_key>" });
const instance = await client.get("<instance_id>");
const authStateId = (await instance.saveAuth({ name: "example_site" })).authStateId;
```

#### Modify an Auth State

```typescript
import { ScrapybaraClient } from "scrapybara";

const client = new ScrapybaraClient({ apiKey: "<api_key>" });
const instance = await client.get("<instance_id>");
await instance.modifyAuth({ authStateId: "your_existing_auth_state_id", name: "renamed_auth_state" });
```

> [!NOTE]
> To apply changes to an auth state in an existing run, set the `authenticatedId` state field to `undefined` to trigger re-authentication.

## Zero Data Retention (ZDR)

LangGraph CUA supports Zero Data Retention (ZDR) via the `zdrEnabled` configuration parameter. When set to true, the graph will _not_ assume it can use the `previous_message_id`, and _all_ AI & tool messages will be passed to the OpenAI on each request.

## Development

To get started with development, first clone the repository:

```bash
git clone https://github.com/langchain-ai/langgraphjs.git
```

Install dependencies:

```bash
yarn install
```

Navigate into the `libs/langgraph-cua` directory:

```bash
cd libs/langgraph-cua
```

Set the required environment variables:

```bash
cp .env.example .env
```

Finally, you can then run the integration tests:

```bash
yarn test:single src/tests/cua.int.test.ts
```
