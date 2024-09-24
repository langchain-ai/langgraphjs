# Part 2: Enhancing the chatbot with tools

To handle queries our chatbot can't answer "from memory", we'll integrate a web search tool call [Tavily](https://tavily.com/). Our bot can use this tool to find relevant information and provide better responses. At the end of this section, your chatbot will be able to search the web and use the results to answer questions with up-to-date information.

**Prerequisites**

If you already completed the [setup steps](/first-agent/0-setup.md) you are ready to get started! To recap, you should have already done the following:

- Signed up for Tavily and received an API key
- Created a `.env` file in the root of your project and added your Tavily API key to it
- Installed the `dotenv` package to load your environment variables from the `.env` file
- Used npm to install the `@langchain/community` package containing the Tavily search tool

If you haven't done any of those steps, you'll need to go back and complete them before proceeding.

Once they're done, you're ready to move on and get your chatbot connected to the internet!

## Step 1: Define the tool for your LLM to use

Let's start by setting up the search tool. We'll need to import the `TavilySearchResults` class and use it to construct a tool the LLM can use.

```ts
// chatbot.ts
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";

const searchTool = new TavilySearchResults({ maxResults: 3 });
```

If you want, you can use the tool directly right now! Add the following lines right under the line where you defined the `tools` variable, then run your project using `npx tsx chatbot.ts`:

```ts
function prettyPrintJSON(json: string) {
	console.log(JSON.stringify(JSON.parse(json), null, 2));
}

prettyPrintJSON(
	// Run the tool
	await searchTool.invoke("What's a 'node' in LangGraph?")
);
```

The `prettyPrintJSON` function makes the content easier to read for us humans. Your output should look something like this, but may contain different search results:

```json
[
	{
		"title": "Low Level LangGraph Concepts - GitHub Pages",
		"url": "https://langchain-ai.github.io/langgraph/concepts/low_level/",
		"content": "Nodes¶ In LangGraph, nodes are typically python functions (sync or async) where the first positional argument is the state, and (optionally), the second positional argument is a \"config\", containing optional configurable parameters (such as a thread_id). Similar to NetworkX, you add these nodes to a graph using the add_node method:",
		"score": 0.999685,
		"raw_content": null
	},
	{
		"title": "LangGraph Tutorial: What Is LangGraph and How to Use It?",
		"url": "https://www.datacamp.com/tutorial/langgraph-tutorial",
		"content": "In LangGraph, each node represents an LLM agent, and the edges are the communication channels between these agents. This structure allows for clear and manageable workflows, where each agent performs specific tasks and passes information to other agents as needed. State management. One of LangGraph's standout features is its automatic state ...",
		"score": 0.998862,
		"raw_content": null
	},
	{
		"title": "Beginner's Guide to LangGraph: Understanding State, Nodes ... - Medium",
		"url": "https://medium.com/@kbdhunga/beginners-guide-to-langgraph-understanding-state-nodes-and-edges-part-1-897e6114fa48",
		"content": "Each node in a LangGraph graph has the ability to access, read, and write to the state. When a node modifies the state, it effectively broadcasts this information to all other nodes within the graph .",
		"score": 0.99819684,
		"raw_content": null
	}
]
```

These search results are the summaries of web pages that our chat bot can use to answer questions.

When you're getting an output similar to this, you've got it working right! If not, verify that your `TAVILY_API_KEY` is set in your `.env` file and loaded using `dotenv`. Also verify that you have the `dotenv` and `@langchain/community` packages installed.

You can delete the call to `searchTool.invoke()` and the `prettyPrintJSON()` function and move on to the next step.

## Step 2: Bind the tool to your LLM

Now that we've created a tool node, we need to bind it to our LLM. This lets the LLM know the correct JSON format to use if it wants to use the Search Engine. We do this by using the `bindTools()` method on our chat model instance - the one created using `new ChatAnthropic()`.

In your `chatbot.ts` file, find the following code where you defined your chat model:

```ts
const model = new ChatAnthropic({
	model: "claude-3-5-sonnet-20240620",
	temperature: 0
});
```

Update it to bind the tool node to the model as follows:

```ts
const model = new ChatAnthropic({
	model: "claude-3-5-sonnet-20240620",
	temperature: 0
}).bindTools([searchTool]);
```

Notice how we passed the tool to `bindTools()`: it was as an array using `[searchTool]`. LLMs can use multiple tools, so the Langchain and LangGraph APIs typically operate on tool _arrays_ rather than individual tools.

Now the LLM will know about the available tools. If it decides any of them would be helpful it will communicate that by responding with a message asking for the tool to be run. The message will contain structured JSON data for its request.

## Step 3: Enabling the chatbot to use a tool

At this point, the chatbot knows how to structure a request to use the search tool, but our graph doesn't provide a way to execute that request. Furthermore, we don't yet have a way to detect when the chatbot wants to use the tool. Let's fix that!

Next, we need to create a `"tools"` node. It will be responsible for actually running the tool. Add the following import at the top of your `chatbot.ts` file:

```ts
import { ToolNode } from "@langchain/langgraph/prebuilt";
```

Then, add the following code after the definition of `searchTool`. Notice that we are once again wrapping the tool in an array:

```ts
const tools = new ToolNode([searchTool]);
```

The `ToolNode` helper handles parsing the message from the LLM to extract the request data, crafting the request to the tool, and returns a tool message containing the response from the tool. You can learn more about `ToolNode` from its [API documentation](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph_prebuilt.ToolNode.html) and the [how-to guide on calling tools using `ToolNode`](https://langchain-ai.github.io/langgraphjs/how-tos/tool-calling/).

The last step is to update our graph to include the new tool. Recall from [part 1: create a chatbot](/first-agent/1-create-chatbot.md) that `edges` route the control flow from one node to the next. **Conditional edges** usually contain `if` statements to route to different nodes depending on the current graph state. These functions receive the current graph state and return a string indicating which node to call next. For our new `tools` node to be run, it's going to need an edge that connects to it.

Let's create a _conditional edge_ function that detects when the chatbot wants to use a tool and communicates that to the graph. Add the following function to your `chatbot.ts` file:

```ts
import type { AIMessage } from "@langchain/core/messages";

function shouldUseTool({ messages }: typeof MessagesAnnotation.State) {
	const lastMessage: AIMessage = messages[messages.length - 1];

	// If the LLM makes a tool call, then we route to the "tools" node
	if (!!lastMessage.tool_calls?.length) {
		return "tools";
	}
	// Otherwise, we stop (reply to the user)
	return "__end__";
}
```

This function will read the last message from the chatbot to check if it asked to use a tool. If it did, it returns the string `"tools"`, which we will need to define as a node in our graph. If the chatbot didn't ask to use a tool, it must be a normal message response, so we return `"__end__"` to indicate that graph's execution is finished.

Now that we have the node and logic for a conditional edge that connects to it, we just need to add them to our graph. Locate the following code where our graph is currently defined and compiled:

```ts
// Create a graph that defines our chatbot workflow and compile it into a `runnable`
export const app = graphBuilder
	.addNode("agent", callModel)
	.addEdge("__start__", "agent")
	.compile();
```

Update it to include the new `tools` node and the conditional edge function:

```ts
export const app = graphBuilder
	.addNode("agent", callModel)
	.addEdge("__start__", "agent")
	.addNode("tools", tools)
    .addConditionalEdges("agent", shouldUseTool)
	.addEdge("tools", "agent")
	.compile();
```

One helpful feature of the graph builder is that if you try to add an edge that connects to a node that doesn't exist, it will result in a type error. This helps you catch bugs in your graph immediately, rather than at runtime.

Conditional edges start from a single node. This tells the graph that any time the `agent` node runs, it should either go to 'tools' if it calls a tool, or end the loop if it responds directly. When the graph transitions to the special `"__end__"` node, it has no more tasks to complete and ceases execution.

You may or may not have noticed that this graph has a simple loop in it: `agent` -> `tools` -> `agent`. The presence of loops is a common pattern in LangGraph graphs. They allow the graph to continue running until the agent has nothing left to do. This is a major difference from common AI chat interfaces, where a single message will only receive a single response. The ability to add loops to a graph enables **agentic behavior**, where the agent can perform multiple actions in service of a single request.

We're ready to put our agent to work! With the update to the graph, it should now be able to use the search tool to find information on the web. Run your project using `npx tsx chatloop.ts` and test it out. You can ask it questions that require current information to answer, like "what's the weather in sf?":

```
User: What's the weather in sf?
Agent:  The current weather in San Francisco is sunny with a temperature of 82.9°F (28.3°C). The wind is coming from the west-northwest at 11.9 mph (19.1 kph), and the humidity is at 32%. There is no precipitation reported, and visibility is good at 16 km (9 miles).

For more details, you can check the full report [here](https://www.weatherapi.com/).
```

Just lovely! If your weather is anything like San Francisco's right now, this is a great opportunity to go outside and enjoy it. You've earned it!

When you're ready, continue on to part 3, where we'll [add persistent state to the chatbot](/first-agent/3-persistent-state.md). This will allow the chatbot to remember past conversations and have multiple threads of discussion.

The final code from this section should look something like the below example. We've cleaned this version up a bit to make it easier to follow:

<details>
```ts
// chatbot.ts
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseMessageLike } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import type { AIMessage } from "@langchain/core/messages";

// read the environment variables from .env
import "dotenv/config";

const searchTool = new TavilySearchResults({ maxResults: 3 });
const tools = new ToolNode([searchTool]);

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
	if (!!lastMessage.tool_calls?.length) {
		return "tools";
	}
	// Otherwise, we stop (reply to the user) using the special "__end__" node
	return "__end__";
}

// Define the graph and compile it into a runnable
export const app = new StateGraph(MessagesAnnotation)
	.addNode("agent", callModel)
	.addEdge("__start__", "agent")
	.addNode("tools", tools)
	.addConditionalEdges("agent", shouldUseTool)
	.addEdge("tools", "agent")
	.compile();
```
</details>

<details>
```ts
// chatloop.ts
import { app } from "./chatbot.ts";

// Create a command line interface to interact with the chat bot
// We'll use these helpers to read from the standard input in the command line
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const lineReader = readline.createInterface({ input, output });

console.log("Type 'exit' or 'quit' to quit");

const messages = Array<BaseMessageLike>();
while (true) {
  const answer = await lineReader.question("User: ");
  if ( ["exit", "quit", "q"].includes( answer.toLowerCase() ) ) {
    console.log("Goodbye!");
    lineReader.close();
    break;
  }
  // Add the user's message to the conversation history
  messages.push({ content: answer, role: "user" });

  // Run the chatbot and add its response to the conversation history
  const output = await app.invoke({ messages });
  messages.push(output.messages[output.messages.length - 1]);

  console.log("Agent: ", output.messages[output.messages.length - 1].content);
}
```
</details>
