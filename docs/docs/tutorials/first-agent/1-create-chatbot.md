# Part 1: Create a chatbot

We'll first create a simple chatbot using LangGraph.js. This chatbot will respond directly to user messages. Though simple, it will illustrate the core concepts of building with LangGraph. By the end of this section, you will have built a rudimentary chatbot.

## Step 1: Create an LLM agent

The first thing we need to do is create an LLM agent. LangGraph makes it easy to use any LLM provider, and we will be using Anthropic's Claude 3.5 Sonnet model. Add the following code to your `chatbot.ts` file:

```ts
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic({
	model: "claude-3-5-sonnet-20240620",
	temperature: 0
});
```

The `ChatAnthropic` class is a wrapper around the Anthropic API that makes it easy to interact with the LLM. We're setting some options on it to configure the LLM:

- `model` needs the API model name of the model we want to use. We're using `claude-3-5-sonnet-20240620`. You can learn more in the [Anthropic models documentation](https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table`).
- `temperature` is a parameter that controls the randomness of the model's output. A temperature of 0 will always return the most likely/predictable token and as the temperature goes towards the max value of 1 the LLM will produce more "creative" outputs. For this tutorial, we'll be using a temperature of 0 to produce more consistent outputs, but feel free to experiment.

## Step 2: Create a StateGraph

The next thing we're going to implement is a [StateGraph](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.StateGraph.html). A `StateGraph` object defines the structure of our chatbot as a "state machine". Nodes can communicate by reading and writing to a shared state. We'll add `nodes` to represent the llm and the functions our chatbot can call. The nodes are connected using `edges` that specify how the bot should transition between these functions.

Add the following code to your `chatbot.ts` file:

```ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

const graphBuilder = new StateGraph(MessagesAnnotation);
```

In this code snippet, we're creating a new `StateGraph` object and passing it our state [`Annotation`](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#annotation). It's so common for chatbot state to be an array of messages that LangGraph provides a helper for it: [`MessagesAnnotation`](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#messagesannotation). This helper defines a state schema with a single field `messages` which is an array of strings. It also provides a reducer function that appends new messages to the array.

Later, we will use the `graphBuilder` object to build a graph that defines how our chatbot will behave by adding nodes and edges to the graph.

## Step 3: Create node that runs the LLM

Now that we have a basic `StateGraph` and and LLM, we need to define a node that will invoke the LLM with the correct state. That's done using a function that takes the current state and returns the new state. Add the following code to your `chatbot.ts` file:

```ts
async function callModel(state: typeof MessagesAnnotation.State) {
	const response = await model.invoke(state.messages);

	// We return the response in an array and the `MessagesAnnotation` reducer will append it to the state
	return { messages: [response] };
}
```

This function is the glue between our `StateGraph` and the LLM. Without it, the LLM wouldn't know what is being asked of it, and the state wouldn't be updated with its response.

## Step 4: Build and run the graph

With the LLM, the `StateGraph`, and a way for them to communicate, we're ready to build our first agent graph! In LangGraph, the entrypoint is defined using a node named `"__start__"`. We need to add our LLM node and connect it to the start node. Add the following code to your `chatbot.ts` file:

```ts
// Create a graph that defines our chatbot workflow and compile it into a `runnable`
export const app = graphBuilder
  .addNode("agent", callModel)
	.addEdge("__start__", "agent")
	.compile();
```

Notice that we're `export`ing the `app` object. This helps us keep the code organized; the agent is defined in `chatbot.ts` and we will write the code that uses it in a separate file. When we go over how to [iterate on an agent using a GUI](5-iterate-studio.md), we will `import` our agent into [LangGraph Studio](https://github.com/langchain-ai/langgraph-studio) too.

At this point we have an app object we can invoke to run our chatbot. To try it out, we're going to need a chat loop that lets us interact with the bot. Let's create a new file called `chatloop.ts` and add logic for our chat loop to it:

```ts
// chatloop.ts
import { BaseMessageLike } from "@langchain/core/messages";

// We need to import the chatbot we created so we can use it here
import { app } from "./chatbot.ts";

// We'll use these helpers to read from the standard input in the command line
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const lineReader = readline.createInterface({ input, output });

console.log("Type 'exit' or 'quit' to quit");
const messages = Array<BaseMessageLike>();
while (true) {
	const answer = await lineReader.question("User: ");
	if (["exit", "quit", "q"].includes(answer.toLowerCase())) {
		console.log("Goodbye!");
		lineReader.close();
		break;
	}
	messages.push({ content: answer, role: "user" });

	// Run the chatbot, providing it the `messages` array containing the conversation
	const output = await app.invoke({ messages });
	messages.push(output.messages[output.messages.length - 1]);
	console.log("Agent: ", output.messages[output.messages.length - 1].content);
}
```

This chat loop uses the [`readline`](https://nodejs.org/api/readline.html) module from Node.js to read user input from the command line. It stores the message history in the `messages` array so that each message _continues_ the conversation, rather than starting a new one each time.

We're calling `app.invoke()` to use the chatbot. Passing it an array of messages containing the conversation history lets us continue a single conversation. In part 3 of this tutorial, we will use a [checkpointer](https://langchain-ai.github.io/langgraphjs/concepts/low_level/?h=messages+annotation#checkpointer) to store conversation history and enable the agent to participate in multiple separate conversation threads. For now, we're manually updating the message history with each new message from the user and agent.

Now that we have a way to interact with the agent, try it out by running the following command:

```bash
npx tsx chatloop.ts
```

Here's an example chat session:

```
User: What's langgraph all about?
Agent: LangGraph is a tool or framework designed to facilitate the development and deployment of applications that leverage large language models (LLMs). It typically focuses on enhancing the capabilities of LLMs by integrating them with various data sources, APIs, and other tools to create more sophisticated and context-aware applications.

LangGraph may include features such as:

1. **Graph-Based Representation**: It often uses graph structures to represent relationships between different entities, which can help in understanding context and improving the relevance of responses generated by LLMs.

2. **Integration with APIs**: LangGraph can connect with various APIs to pull in real-time data, allowing applications to provide up-to-date information and contextually relevant responses.

3. **Custom Workflows**: Users can create custom workflows that define how the LLM interacts with different data sources and processes information, making it adaptable to specific use cases.

4. **Enhanced Contextual Understanding**: By utilizing graph structures, LangGraph can improve the model's ability to understand and generate responses based on complex relationships and hierarchies within the data.

5. **Applications**: It can be used in various domains, including customer support, content generation, data analysis, and more, where natural language understanding and generation are crucial.

For the most accurate and up-to-date information, I recommend checking the official LangGraph website or relevant documentation, as developments in technology can lead to new features and capabilities.
User: what problems does it solve?
Agent:  LangGraph addresses several challenges associated with the use of large language models (LLMs) in application development and deployment. Here are some of the key problems it aims to solve:

1. **Contextual Understanding**: LLMs can struggle with maintaining context over long conversations or complex queries. LangGraph's graph-based representation helps in organizing and managing contextual information, allowing for more coherent and relevant responses.

2. **Data Integration**: Many applications require data from multiple sources (e.g., databases, APIs). LangGraph facilitates the integration of these diverse data sources, enabling LLMs to access real-time information and provide more accurate and context-aware responses.

3. **Complex Query Handling**: Users often pose complex queries that involve multiple entities or relationships. LangGraph can help break down these queries and manage the relationships between different pieces of information, improving the model's ability to generate relevant answers.

4. **Customization and Flexibility**: Different applications have unique requirements. LangGraph allows developers to create custom workflows and interactions tailored to specific use cases, making it easier to adapt LLMs to various domains and tasks.

5. **Scalability**: As applications grow and require more data and interactions, managing these efficiently can become challenging. LangGraph's architecture can help scale applications by organizing data and interactions in a way that remains manageable.

6. **Improved User Experience**: By enhancing the LLM's ability to understand context and integrate data, LangGraph can lead to a more satisfying user experience, as users receive more accurate and relevant responses to their queries.

7. **Error Reduction**: By providing a structured way to manage data and context, LangGraph can help reduce errors in responses generated by LLMs, particularly in scenarios where precision is critical.

8. **Interactivity**: LangGraph can enable more interactive applications, where users can engage in dynamic conversations or queries that adapt based on previous interactions, leading to a more engaging experience.

Overall, LangGraph aims to enhance the capabilities of LLMs, making them more effective tools for a wide range of applications, from customer support to content generation and beyond.
User: q
Goodbye!
```

**Congratulations!** You've built your first chatbot using LangGraph. This bot can engage in basic conversation by taking user input and generating responses using an LLM. You can inspect a [LangSmith Trace](https://smith.langchain.com/public/29ab0177-1177-4d25-9341-17ae7d94e0e0/r) for the call above at the provided link.

However, you may have noticed that the bot's knowledge is limited to what's in its training data. In the next part, we'll add a web search tool to expand the bot's knowledge and make it more capable.

Below is the full code for this section for your reference:

<details>
```ts
// chatbot.ts
import { ChatAnthropic } from "@langchain/anthropic";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

// read the environment variables from .env
import "dotenv/config";

// Create a model and give it access to the tools
const model = new ChatAnthropic({
	model: "claude-3-5-sonnet-20240620",
	temperature: 0,
});

// Define the function that calls the model
async function callModel(state: typeof MessagesAnnotation.State) {
	const messages = state.messages;

  const response = await model.invoke(messages);

  // We return a list, because this will get added to the existing list
	return { messages: response };
}

const graphBuilder = new StateGraph(MessagesAnnotation);

// Create a graph that defines our chatbot workflow and compile it into a `runnable`
export const app = graphBuilder
	.addNode("agent", callModel)
	.addEdge("__start__", callModel)
	.compile();

````
</details>

<details>
```ts
// chatloop.ts
import { app } from "./chatbot.ts";

import { BaseMessageLike } from "@langchain/core/messages";

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
	messages.push({ content: answer, type: "user" });

	// Run the chatbot and add its response to the conversation history
	const output = await app.invoke({ messages });
	messages.push(output.messages[output.messages.length - 1]);
	console.log("Agent: ", output.messages[output.messages.length - 1].content);
}
```
</details>
