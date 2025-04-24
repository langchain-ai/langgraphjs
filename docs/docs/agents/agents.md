# Agents

## What is an agent?

An *agent* consists of three components: a **large language model (LLM)**, a set of **tools** it can use, and a **prompt** that provides instructions.

The LLM operates in a loop. In each iteration, it selects a tool to invoke, provides input, receives the result (an observation), and uses that observation to inform the next action. The loop continues until a stopping condition is met — typically when the agent has gathered enough information to respond to the user.

<figure markdown="1">
![image](./assets/agent.png){: style="max-height:400px"}
<figcaption>Agent loop: the LLM selects tools and uses their outputs to fulfill a user request.</figcaption>
</figure>

## Basic configuration

Use [`createReactAgent`](/langgraphjs/reference/functions/langgraph_prebuilt.createReactAgent.html) to instantiate an agent:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(  // (1)!
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

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");  // (2)!
const agent = createReactAgent({
  llm,
  tools: [getWeather],  // (3)!
  prompt: "You are a helpful assistant"  // (4)!
})

// Run the agent
await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] }
);
```

1. Define a tool for the agent to use. For more advanced tool usage and customization, check the [tools](./tools.md) page.
2. Provide a language model for the agent to use. To learn more about configuring language models for the agents, check the [models](./models.md) page.
3. Provide a list of tools for the model to use.
4. Provide a system prompt (instructions) to the language model used by the agent.

## LLM configuration

Use [`initChatModel`](https://api.js.langchain.com/functions/langchain.chat_models_universal.initChatModel.html) to configure an LLM with specific parameters, such as temperature:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";

// highlight-next-line
const llm = await initChatModel(
  "anthropic:claude-3-7-sonnet-latest",
  {
    // highlight-next-line
    temperature: 0
  }
);

const agent = createReactAgent({
  // highlight-next-line
  llm,
  tools: [getWeather]
});
```

See the [models](./models.md) page for more information on how to configure LLMs.

## Custom Prompts

Prompts instruct the LLM how to behave. They can be:

* **Static**: A string is interpreted as a **system message**
* **Dynamic**: a list of messages generated at **runtime** based on input or configuration

### Static prompts

Define a fixed prompt string or list of messages.

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // A static prompt that never changes
  // highlight-next-line
  prompt: "Never answer questions about the weather."
});

await agent.invoke({
  messages: "what is the weather in sf"
});
```

### Dynamic prompts

Define a function that returns a message list based on the agent's state and configuration:

```ts
import { BaseMessageLike } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { initChatModel } from "langchain/chat_models/universal";
import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const prompt = (
  state: typeof MessagesAnnotation.State, config: RunnableConfig
): BaseMessageLike[] => {  // (1)!
  const userName = config.configurable?.userName;
  const systemMsg = `You are a helpful assistant. Address the user as ${userName}.`;
  return [{ role: "system", content: systemMsg }, ...state.messages];
};

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // highlight-next-line
  prompt
});

await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] },
  // highlight-next-line
  { configurable: { userName: "John Smith" } }
);
```

1. Dynamic prompts allow including non-message [context](./context.md) when constructing an input to the LLM, such as:

    - Information passed at runtime, like a `userId` or API credentials (using `config`).
    - Internal agent state updated during a multi-step reasoning process (using `state`).

    Dynamic prompts can be defined as functions that take `state` and `config` and return a list of messages to send to the LLM.

See the [context](./context.md) page for more information.

## Memory

To allow multi-turn conversations with an agent, you need to enable [persistence](../concepts/persistence.md) by providing a `checkpointer` when creating an agent. At runtime you need to provide a config containing `thread_id` — a unique identifier for the conversation (session):

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { initChatModel } from "langchain/chat_models/universal";

// highlight-next-line
const checkpointer = new MemorySaver();

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // highlight-next-line
  checkpointer  // (1)!
});

// Run the agent
// highlight-next-line
const config = { configurable: { thread_id: "1" } };
const sfResponse = await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] },
  config  // (2)!
);
const nyResponse = await agent.invoke(
  { messages: [ { role: "user", content: "what about new york?" } ] },
  config
);
```

1. `checkpointer` allows the agent to store its state at every step in the tool calling loop. This enables [short-term memory](./memory.md#short-term-memory) and [human-in-the-loop](./human-in-the-loop.md) capabilities.
2. Pass configuration with `thread_id` to be able to resume the same conversation on future agent invocations.

When you enable the checkpointer, it stores agent state at every step in the provided checkpointer database (or in memory, if using `InMemorySaver`).

Note that in the above example, when the agent is invoked the second time with the same `thread_id`, the original message history from the first conversation is automatically included, together with the new user input.

Please see the [memory guide](./memory.md) for more details on how to work with memory.

## Structured output

To produce structured responses conforming to a schema, use the `responseFormat` parameter. The schema can be defined with a `zod` schema. The result will be accessible via the `structuredResponse` field.

```ts
import { z } from "zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";

const WeatherResponse = z.object({
  conditions: z.string()
});

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // highlight-next-line
  responseFormat: WeatherResponse  // (1)!
});

const response = await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] }
);
// highlight-next-line
response.structuredResponse;
```

1. When `responseFormat` is provided, a separate step is added at the end of the agent loop: agent message history is passed to an LLM with structured output to generate a structured response.

    To provide a system prompt to this LLM, use an object `{ prompt, schema }`, e.g., `responseFormat: { prompt, schema: WeatherResponse }`.

!!! Note "LLM post-processing"

    Structured output requires an additional call to the LLM to format the response according to the schema.

