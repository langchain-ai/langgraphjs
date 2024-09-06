# Part 4: Human-in-the-loop


Agents can be unreliable and may need human input to successfully accomplish tasks. Similarly, for some actions, you may want to require human confirmation before sensitive tasks/actions like making a purchase.

LangGraph supports `human-in-the-loop` workflows in a number of ways. In this section, we will use LangGraph's `interrupt_before` functionality to always break the tool node.

We'll be continuing using the final code from [part 3 - adding memory to the chatbot](/first-agent/3-persistent-state.md). If you haven't been following along, make sure you complete the [setup steps](/first-agent/0-setup.md) and copy the code from part 3 before continuing.

## Step 1: Interrupt agent execution

To start, we need to decide *where* in the graph's execution the agent should wait for human feedback. LangGraph provides two options - *before* or *after* a node is run. Let's set up the agent to wait for human feedback before using a tool.

Interrupts don't change the *structure* of the graph, only how it is *executed*. As a result, we don't need to change the way we build the graph. Instead, we'll specify where we want interrupts to occur when we *compile* the graph.

Locate the code that builds and compiles the graph in your `chatbot.ts` file. It should look like this:

```ts
// Define the graph and compile it into a runnable
const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addNode("tools", new ToolNode(tools))
  .addConditionalEdges("agent", shouldUseTool)
  .addEdge("tools", "agent")
  .compile({ checkpointer: new MemorySaver() });
```

We need to change the last line - the `.compile()` call - to specify we want an interrupt before the `"tools"` node runs. It's possible to add interrupts before multiple nodes, so we will specify our interrupts as an array. Since we only want to interrupt before one node, it'll be an array with a single value. Update the `compile` code to the following:

```ts
.compile({ checkpointer: new MemorySaver(), interruptBefore: ["tools"] });
```

This change will cause the agent's execution to stop before it runs a tool. Before we can try it out to see how it works, we need to make an update to our chat loop.

Currently, the chat loop prints the `content` of the last message from the agent. This has worked so far because when the agent requested a tool, the `"tools"` node ran it and then the agent got invoked again with the results. Now that execution is interrupted before the `"tools"` node, the last message from the agent will be the one requesting to use a tool. Those messages have no `content`, so trying to chat now will result in what feels like the agent equivalent of a blank stare:

```
User: How's the weather today in sf?
Agent: 
```

Let's update how we log the output of the agent so we can see what's going on. Find the final `console.log` and update it to remove the final `.content` so it matches the following:

```ts
  console.log("Agent: ", output.messages[output.messages.length - 1]);
```

Now when the agent wants to use a tool, we can see the full request. Try it out by running `npx tsx chatbot.ts`. Your result should look something like this:

```
User: I'm learning LangGraph. Could you do some research on it for me?
Agent:  AIMessage {
  "id": "chatcmpl-A4ZQ4tc5ILjuPX8oV0Ovud2W7pqpr",
  "content": "",
  "response_metadata": {
    "tokenUsage": {
      "completionTokens": 19,
      "promptTokens": 87,
      "totalTokens": 106
    },
    "finish_reason": "tool_calls",
    "system_fingerprint": "fp_483d39d857"
  },
  "tool_calls": [
    {
      "name": "tavily_search_results_json",
      "args": {
        "input": "LangGraph"
      },
      "type": "tool_call",
      "id": "call_CRsquDkg5zJ5DGwSqXCA7KP5"
    }
  ],
  "invalid_tool_calls": [],
  "usage_metadata": {
    "input_tokens": 87,
    "output_tokens": 19,
    "total_tokens": 106
  }
}
```

If you try to continue the conversation, you'll get an error because it's expecting the next message to come from a tool, not a human. We'll fix that in the next step.

## Step 2: Add human confirmation

Right now, the code in our chat loop that is responsible for running the agent and printing the result looks something like this:

```ts
  // Run the chatbot and add its response to the conversation history
  const output = await app.invoke(
    {
      messages: [{ content: answer, type: "user" }],
    },
    { configurable: { thread_id: "42" } },
  );

  console.log("Agent: ", output.messages[output.messages.length - 1]);
```
There's nothing here to detect if the agent is trying to run a tool, nor is there a way for a human to confirm that it's okay for the tool to run. We need to change that!

Notice that in the `AIMessage` object example at the end of step 1, the `AIMessage` object has a `tool_calls` field. If that field contains an array, the agent is requesting a tool run. Otherwise, the field will be `undefined`. Let's update our chat loop to check for it and ask the human if graph execution should continue.

Add the following code in between the `app.invoke()` call and the subsequent `console.log()` that prints the output:

```ts
  // 1. Check if the AI is trying to use a tool
  const lastMessage = output.messages[output.messages.length - 1];
  if (
    lastMessage instanceof AIMessage &&
    lastMessage.tool_calls !== undefined
  ) {
    console.log(
      "Agent: I would like to make the following tool calls: ",
      lastMessage.tool_calls,
    );

    // 2. Let the human decide whether to continue or not
    const humanFeedback = await lineReader.question(
      "Type 'y' to continue, or anything else to exit: ",
    );
    if (humanFeedback.toLowerCase() !== "y") {
      console.log("Goodbye!");
      lineReader.close();
      break;
    }

    // 3. No new state is needed for the agent to use the tool, so pass `null`
    const outputWithTool = await app.invoke(null, {
      configurable: { thread_id: "42" },
    });
    console.log(
      "Agent: ",
      outputWithTool.messages[outputWithTool.messages.length - 1].content,
    );
    continue;
  }
```

There are three things going on here:
1. We are checking if the agent wants to use a tool. If it does, we print out the details of the requested tool call so the human can make a decision.
2. We ask the human if they want to continue. If they don't, we exit the chat loop.
3. Since the graph execution was simply paused, we don't need to add any new state to continue. Once the human has approved the tool call, we continue execution by calling `app.invoke()` again with `null` as the new state.

Try running the chatbot again with `npx tsx chatbot.ts`. When the agent requests a tool, you should see the details of the request tool call and be prompted to continue. If you type `y`, the agent will continue and run the tool. If you type anything else, the chat loop will exit.

Here's an example run:

```
User: I'm learning LangGraph. Could you do some research on it for me?
Agent: I would like to make the following tool calls:  [
  {
    name: 'tavily_search_results_json',
    args: { input: 'LangGraph' },
    type: 'tool_call',
    id: 'call_pEIxSTbokDU1c1ba0UsEACAH'
  }
]
Type 'y' to continue, or anything else to exit: y
Agent:  Here are some key resources and information about LangGraph:

1. **LangGraph Overview**:
   - **Website**: [LangChain](https://www.langchain.com/langgraph)
   - LangGraph is a framework designed for building stateful, multi-actor agents using large language models (LLMs). It allows for handling complex scenarios and enables collaboration with humans. You can use LangGraph with Python or JavaScript and deploy your agents at scale using LangGraph Cloud.

2. **Documentation and Features**:
   - **GitHub Pages**: [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
   - This documentation provides insights into creating stateful, multi-actor applications with LLMs. It covers concepts like cycles, controllability, and persistence, along with examples and integration with LangChain and LangSmith.

3. **Tutorials and Guides**:
   - **DataCamp Tutorial**: [LangGraph Tutorial](https://www.datacamp.com/tutorial/langgraph-tutorial)
   - This tutorial explains how to use LangGraph to develop complex, multi-agent LLM applications. It focuses on creating stateful, flexible, and scalable systems, detailing the use of nodes, edges, and state management.

These resources should help you get started with LangGraph and understand its capabilities in building advanced applications with LLMs.
User: when should I use langgraph vs langchain?
Agent: I would like to make the following tool calls:  [
  {
    name: 'tavily_search_results_json',
    args: { input: 'when to use LangGraph vs LangChain' },
    type: 'tool_call',
    id: 'call_Q0b5YA0I9ibuqDVhG9ftHfu6'
  }
]
Type 'y' to continue, or anything else to exit: y
Agent:  When deciding between LangGraph and LangChain, consider the following points:

1. **LangGraph**:
   - **Use Case**: LangGraph is specifically designed for building stateful, multi-actor agents. It excels in scenarios where you need to manage complex interactions and workflows among multiple agents or components.
   - **Features**: It allows for the creation of intelligent AI agents using graph structures, enabling more powerful and flexible applications. LangGraph is particularly useful for applications that require collaboration between agents and human users.
   - **Ideal For**: If your project involves multi-agent environments or requires advanced state management and interaction patterns, LangGraph is the better choice.

2. **LangChain**:
   - **Use Case**: LangChain is a more general framework for building applications powered by large language models (LLMs). It simplifies the development of applications by allowing you to define and execute action sequences (chains) easily.
   - **Features**: LangChain supports the creation of directed acyclic graphs (DAGs) for managing workflows, making it suitable for a wide range of LLM applications.
   - **Ideal For**: If your project focuses on simpler applications or workflows that do not require the complexity of multi-agent interactions, LangChain may be sufficient.

In summary, use **LangGraph** for complex, multi-agent applications requiring advanced state management, and use **LangChain** for more straightforward LLM applications that benefit from action chaining.
User: quit
Goodbye!
```

## Conclusion

**Congrats!** You've used an `interrupt` to add human-in-the-loop execution to your chatbot, allowing for human oversight and intervention when needed. This opens up the potential UIs you can create with your AI systems. Since we have already added a **checkpointer**, the graph can be paused *indefinitely* and resumed at any time as if nothing had happened.

Next, we'll explore our agent graph using LangGraph Studio. Studio makes it possible to visualize the graph, inspect its state, and debug it in real-time. 

Below is a copy of the final code from this section.


<details>
```ts
import { ChatOpenAI, wrapOpenAIClientError } from "@langchain/openai";
import { AIMessage, BaseMessageLike } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { MemorySaver } from "@langchain/langgraph";
import dotenv from "dotenv";

// read the environment variables from .env
dotenv.config();

const tools = [new TavilySearchResults({ maxResults: 3 })];
// Create a model and give it access to the tools
const model = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0,
}).bindTools(tools);

// Define the function that calls the model
async function callModel(state: typeof MessagesAnnotation.State) {
  const messages = state.messages;

  const response = await model.invoke(messages);

  return { messages: response };
}

function shouldUseTool(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages[state.messages.length - 1];

  // If the LLM makes a tool call, then we route to the "tools" node
  if (lastMessage.additional_kwargs.tool_calls) {
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
  .compile({ checkpointer: new MemorySaver(), interruptBefore: ["tools"] });

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

  // Run the chatbot and add its response to the conversation history
  const output = await app.invoke(
    {
      messages: [{ content: answer, type: "user" }],
    },
    { configurable: { thread_id: "42" } },
  );

  // Check if the AI is trying to use a tool
  const lastMessage = output.messages[output.messages.length - 1];
  if (
    lastMessage instanceof AIMessage &&
    lastMessage.tool_calls !== undefined
  ) {
    console.log(
      "Agent: I would like to make the following tool calls: ",
      lastMessage.tool_calls,
    );

    // Let the human decide whether to continue or not
    const humanFeedback = await lineReader.question(
      "Type 'y' to continue, or anything else to exit: ",
    );
    if (humanFeedback.toLowerCase() !== "y") {
      console.log("Goodbye!");
      lineReader.close();
      break;
    }

    // No new state is needed for the agent to use the tool, so pass `null`
    const outputWithTool = await app.invoke(null, {
      configurable: { thread_id: "42" },
    });
    console.log(
      "Agent: ",
      outputWithTool.messages[outputWithTool.messages.length - 1].content,
    );
    continue;
  }

  console.log("Agent: ", output.messages[output.messages.length - 1]);
}
```
</details>
