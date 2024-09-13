# Part 3: Adding memory to the chatbot

Our chatbot can now use tools to answer user questions, but it doesn't remember the context of previous interactions. This limits its ability to have coherent, multi-turn conversations.

LangGraph solves this problem through **persistent checkpointing**. If you provide a [`checkpointer`](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#checkpointer) when compiling the graph and a `thread_id` when calling your graph, LangGraph automatically saves the state after each step. When you invoke the graph again using the same `thread_id`, the graph loads its saved state, allowing the chatbot to pick up where it left off.

We will see later that **checkpointing** is _much_ more powerful than simple chat memory - it lets you save and resume complex state at any time for error recovery, human-in-the-loop workflows, time travel interactions, and more. But before we get too ahead of ourselves, let's add checkpointing to enable multi-turn conversations.

## Step 1: Add a `MemorySaver` checkpointer

To get started, create a `MemorySaver` checkpointer. `MemorySaver` is an in-memory checkpointer that saves the state of the graph in memory. This is useful for testing and development, but in production, you will want to use a persistent checkpointer like [`SqliteSaver`](https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint_sqlite.SqliteSaver.html) or [`MongoDBSaver`](https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint_mongodb.MongoDBSaver.html). For this tutorial, `MemorySaver` is sufficient.

First, we need to import the `MemorySaver` class from LangGraph. Add the import statement to the top of your `chatbot.ts` file:

```ts
import { MemorySaver } from "@langchain/langgraph";
```
Then, update the code that creates the runnable agent to use a checkpointer. As a reminder, it should currently look like this:

```ts
// Define the graph and compile it into a runnable
const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addNode("tools", new ToolNode(tools))
  .addConditionalEdges("agent", shouldUseTool)
  .addEdge("tools", "agent")
  .compile();
```

We need to pass an instance of `MemorySaver` to the `compile` method. Update the last to the following:
```ts
.compile({ checkpointer: new MemorySaver() });
```

This change doesn't affect how the graph runs. All we are doing is saving a checkpoint of the graph state as it works through each node.

## Step 2: Replace manual state track with the checkpointer

Previously, we were manually tracking the state of the conversation using the `messages` array. Now that the graph has a checkpointer, we don't have to track the state manually. 

Let's remove the `messages` array and the code that updates it with messages from the user and agent. Delete the following 3 bits of code from near the bottom of your `chatbot.ts` file:

```ts
const messages = Array<BaseMessageLike>();

// Add the user's message to the conversation history
messages.push({ content: answer, role: "user" });

messages.push(output.messages[output.messages.length - 1]);
```

Since `messages` is no longer defined, we're getting an error now on the following line where the chatbot is invoked:

```ts
const output = await app.invoke({ messages });
```

The app still needs us to pass the *new* message from the user when we invoke it, but the checkpointer will save it to the graph's state after that. Update the line to the following:

```ts
  const output = await app.invoke({
      messages: [{ content: answer, role: "user" }],
    },
    { configurable: { thread_id: "42" } }
  );
```

Notice that we are now passing **two** arguments to `invoke()` - the first object contains the messages, and the second object contains the configurable `thread_id`.

We're using the `MessagesAnnotation` helper, which has a reducer that will append the new message to the graph's `messages` state. This way each time we invoke the chatbot it will get the new message and all the previous messages from this conversation thread.

The `Runnable` now has access to a checkpointer to save progress as it executes the graph. To use it, we are providing a `thread_id` value when calling `.invoke()`. In a real application, you'd probably want to generate unique thread IDs using something like UUID or nanoid. For now, we're using a hardcoded value of "42".

At this point, the chatbot should be back to a runnable state! Test it's memory out by asking some questions that depend on the context of the previous question(s).

As a reminder, you can run it with `npx tsx chatbot.ts`. Let's try asking it about the weather in a few locations, but not tell it we're asking about the weather each time. If it has context of the previous questions, it should be able to figure it out anyway.

```
User: what's the weather in seattle?
Agent:  The current weather in Seattle is sunny with a temperature of 31.7°C (89.1°F). The wind is coming from the west-northwest at 4.3 mph, and the humidity is at 35%. There is no precipitation, and visibility is good at 16 km (9 miles).

For more details, you can check the full report [here](https://www.weatherapi.com/).
User: how about ny
Agent:  The current weather in New York is clear with a temperature of 20.6°C (69.1°F). The wind is coming from the east-northeast at 6.9 mph, and the humidity is at 57%. There is no precipitation, and visibility is good at 16 km (9 miles).

For more details, you can check the full report [here](https://www.weatherapi.com/).
User: q
Goodbye!
```

Wow, it sure is nice out! And even the we only asked "how about ny", the chatbot was able to infer that we were asking about the weather. This is because it remembered the context of the previous question.

Great job getting this far! When you're ready to continue, we're going to [add a human in the loop](/first-agent/4-human-loop.md) for any actions we don't want the chatbot to take with full autonomy.

Here's what the final code from this section looks like:

<details>
```ts
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { MemorySaver } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";

// read the environment variables from .env
import "dotenv/config";

const tools = [new TavilySearchResults({ maxResults: 3 })];

// Create a model and give it access to the tools
const model = new ChatAnthropic({
  model: "claude-3-5-sonnet-20240620",
  temperature: 0,
}).bindTools(tools);

// Define the function that calls the model
async function callModel(state: typeof MessagesAnnotation.State) {
  const messages = state.messages;

  const response = await model.invoke(messages);

  return { messages: response };
}

function shouldUseTool(state: typeof MessagesAnnotation.State) {
  const lastMessage: AIMessage = state.messages[state.messages.length - 1];

  // If the LLM makes a tool call, then we route to the "tools" node
  if (lastMessage.tool_calls?.length) {
    return "tools";
  }
  // Otherwise, we stop (reply to the user) using the special "__end__" node
  return "__end__";
}

// Define the graph and compile it into a runnable
const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addNode("tools", new ToolNode(tools))
  .addConditionalEdges("agent", shouldUseTool)
  .addEdge("tools", "agent")
  .compile({ checkpointer: new MemorySaver() });

// Create a command line interface to interact with the chat bot

// We'll use these helpers to read from the standard input in the command line
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const lineReader = readline.createInterface({ input, output });

console.log("Type 'exit' or 'quit' to quit");

while (true) {
  const answer = await lineReader.question("User: ");
  if (["exit", "quit", "q"].includes(answer.toLowerCase())) {
    console.log("Goodbye!");
    lineReader.close();
    break;
  }

  // Run the chatbot with the user's input, using the same thread_id each time. 
  const output = await app.invoke(
    {
      messages: [{ content: answer, role: "user" }],
    },
    { configurable: { thread_id: "42" } },
  );

  console.log("Agent: ", output.messages[output.messages.length - 1].content);
} 
```
</details>
