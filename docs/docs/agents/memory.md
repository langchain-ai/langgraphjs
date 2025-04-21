# Memory

LangGraph supports two types of memory essential for building conversational agents:

- **[Short-term memory](#short-term-memory)**: Tracks the ongoing conversation by maintaining message history within a session.
- **[Long-term memory](#long-term-memory)**: Stores user-specific or application-level data across sessions.

This guide demonstrates how to use both memory types with agents in LangGraph. For a deeper
understanding of memory concepts, refer to the [LangGraph memory documentation](../concepts/memory.md).

<figure markdown="1">
![image](./assets/memory.png){: style="max-height:400px"}
<figcaption>Both <strong>short-term</strong> and <strong>long-term</strong> memory require persistent storage to maintain continuity across LLM interactions. In production environments, this data is typically stored in a database.</figcaption>
</figure>

!!! note "Terminology"

    In LangGraph:

    - *Short-term memory* is also referred to as **thread-level memory**.
    - *Long-term memory* is also called **cross-thread memory**.

    A [thread](../concepts/persistence.md#threads) represents a sequence of related runs
    grouped by the same `thread_id`.

## Short-term memory

Short-term memory enables agents to track multi-turn conversations. To use it, you must:

1. Provide a `checkpointer` when creating the agent. The `checkpointer` enables [persistence](../concepts/persistence.md) of the agent's state.
2. Supply a `thread_id` in the config when running the agent. The `thread_id` is a unique identifier for the conversation session.

```ts
// highlight-next-line
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// highlight-next-line
const checkpointer = new MemorySaver();  // (1)!

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
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // highlight-next-line
  checkpointer  // (2)!
});

// Run the agent
// highlight-next-line
const config = { configurable: { thread_id: "1" } };  // (3)!
const sfResponse = await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] },
  config  // (4)!
);
const nyResponse = await agent.invoke(
  { messages: [ { role: "user", content: "what about new york?" } ] },
  config
);
```

1. The `MemorySaver` is a checkpointer that stores the agent's state in memory. In a production setting, you would typically use a database or other persistent storage. Please review the [checkpointer documentation](https://langchain-ai.github.io/langgraphjs/reference/index.html) for more options. If you're deploying with **LangGraph Platform**, the platform will provide a production-ready checkpointer for you.
2. The `checkpointer` is passed to the agent. This enables the agent to persist its state across invocations. Please note that 
3. A unique `thread_id` is provided in the config. This ID is used to identify the conversation session. The value is controlled by the user and can be any string.
4. The agent will continue the conversation using the same `thread_id`. This will allow the agent to infer that the user is asking specifically about the **weather** in New York. 

When the agent is invoked the second time with the same `thread_id`, the original message history from the first conversation is automatically included, allowing the agent to infer that the user is asking specifically about the **weather** in New York.

!!! Note "LangGraph Platform providers a production-ready checkpointer"

    If you're using [LangGraph Platform](./deployment.md), during deployment your checkpointer will be automatically configured to use a production-ready database.

## Long-term memory

Use long-term memory to store user-specific or application-specific data across conversations. This is useful for applications like chatbots, where you want to remember user preferences or other information.

To use long-term memory, you need to:

1. [Configure a store](../how-tos/cross-thread-persistence.ipynb) to persist data across invocations.
2. Use the `config.store` to access the store from within tools or prompts.

### Reading

```ts title="A tool the agent can use to look up user information"
import { initChatModel } from "langchain/chat_models/universal";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
// highlight-next-line
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
// highlight-next-line
import { getStore } from "@langchain/langgraph";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const store = new InMemoryStore(); // (1)!

await store.put(  // (2)!
  ["users"],  // (3)!
  "user_123",  // (4)!
  {
    name: "John Smith",
    language: "English",
  } // (5)!
);

// Look up user info tool
const getUserInfo = tool(
  async (input: Record<string, any>, config: LangGraphRunnableConfig): Promise<string> => {
    // Same as that provided to `createReactAgent`
    const store = config.store; // (6)!
    if (!store) {
      throw new Error("store is required when compiling the graph");
    }

    const userId = config.configurable?.userId;
    if (!userId) {
      throw new Error("userId is required in the config");
    }

    const userInfo = await store.get(["users"], userId); // (7)!
    return userInfo ? JSON.stringify(userInfo.value) : "Unknown user";
  },
  {
    name: "get_user_info",
    description: "Look up user info.",
    schema: z.object({}),
  }
);

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [getUserInfo],
  store, // (8)!
});

// Run the agent
const response = await agent.invoke(
  { messages: [ { role: "user", content: "look up user information" } ] },
  { configurable: { userId: "user_123" } }
);
```

1. The `InMemoryStore` is a store that stores data in memory. In a production setting, you would typically use a database or other persistent storage. Please review the [documentation](https://langchain-ai.github.io/langgraphjs/reference/index.html) for more options. If you're deploying with **LangGraph Platform**, the platform will provide a production-ready store for you.
2. For this example, we write some sample data to the store using the `put` method. Please see the [BaseStore.put](https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint.BaseStore.html#put) API reference for more details.
3. The first argument is the namespace. This is used to group related data together. In this case, we are using the `users` namespace to group user data.
4. A key within the namespace. This example uses a user ID for the key.
5. The data that we want to store for the given user.
6. You can access the store via `config.store` from anywhere in your nodes, tools and prompts. It contains the store that was passed to the agent when it was created.
7. The `get` method is used to retrieve data from the store. The first argument is the namespace, and the second argument is the key. This will return a `StoreValue` object, which contains the value and metadata about the value.
8. The `store` is passed to the agent. This enables the agent to access the store when running tools.

### Writing

```ts title="Example of a tool that updates user information"
import { initChatModel } from "langchain/chat_models/universal";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { getStore } from "@langchain/langgraph";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const store = new InMemoryStore(); // (1)!

interface UserInfo { // (2)!
  name: string;
}

// Save user info tool
const saveUserInfo = tool(  // (3)!
  async (input: UserInfo, config: LangGraphRunnableConfig): Promise<string> => {
    // Same as that provided to `createReactAgent`
    // highlight-next-line
    const store = config.store; // (4)!
    if (!store) {
      throw new Error("store is required when compiling the graph");
    }

    const userId = config.configurable?.userId;
    if (!userId) {
      throw new Error("userId is required in the config");
    }

    await store.put(["users"], userId, input); // (5)!
    return "Successfully saved user info.";
  },
  {
    name: "save_user_info",
    description: "Save user info.",
    schema: z.object({
      name: z.string(),
    }),
  }
);

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [saveUserInfo],
  // highlight-next-line
  store,
});

// Run the agent
await agent.invoke(
  { messages: [ { role: "user", content: "My name is John Smith" } ] },
  { configurable: { userId: "user_123" } } // (6)!
);

// You can access the store directly to get the value
const userInfo = await store.get(["users"], "user_123")
userInfo.value
```

1. The `InMemoryStore` is a store that stores data in memory. In a production setting, you would typically use a database or other persistent storage. Please review the [store documentation](../reference/stores.md) for more options. If you're deploying with **LangGraph Platform**, the platform will provide a production-ready store for you.
2. The `UserInfo` class is an interface that defines the structure of the user information. We will specify the same schema below using a zod object, so that the LLM formats the response according to the schema.
3. The `saveUserInfo` is a tool that allows an agent to update user information. This could be useful for a chat application where the user wants to update their profile information.
4. You can access the store via `config.store` from anywhere in your nodes, tools and prompts. It contains the store that was passed to the agent when it was created.
5. The `put` method is used to store data in the store. The first argument is the namespace, and the second argument is the key. This will store the user information in the store.
6. The `userId` is passed in the config. This is used to identify the user whose information is being updated.

## Additional resources

* [Memory in LangGraph](../concepts/memory.md)