# Memory

## What is Memory?

Memory in the context of LLMs and AI applications refers to the ability to process, retain, and utilize information from past interactions or data sources. Examples include:

- Managing what messages (e.g., from a long message history) are sent to a chat model to limit token usage
- Summarizing past conversations to give a chat model context from prior interactions
- Selecting few shot examples (e.g., from a dataset) to guide model responses
- Maintaining persistent data (e.g., user preferences) across multiple chat sessions
- Allowing an LLM to update its own prompt using past information (e.g., meta-prompting)
- Retrieving information relevant to a conversation or question from a long-term storage system

Below, we'll discuss each of these examples in some detail. 

## Managing Messages

### Editing message lists

Chat models accept instructions through [messages](https://js.langchain.com/docs/concepts/#messages), which can serve as general instructions (e.g., a system message) or user-provided instructions (e.g., human messages). In chat applications, messages often alternate between human inputs and model responses, accumulating in a list over time. Because context windows are limited and token-rich message lists can be costly, many applications can benefit from approaches to actively manage messages.    

The most directed approach is to remove specific messages from a list. This can be done using [RemoveMessage](/langgraphjs/how-tos/delete-messages/#manually-deleting-messages) based upon the message `id`, a unique identifier for each message. In the below example, we keep only the last two messages in the list using `RemoveMessage` to remove older messages based  upon their `id`.

```typescript
import { RemoveMessage, AIMessage, HumanMessage } from "@langchain/core/messages";

// Message list
const messages = [new AIMessage({ content: "Hi.", name: "Bot", id: "1" })];
messages.push(new HumanMessage({ content: "Hi.", name: "Lance", id: "2" }));
messages.push(new AIMessage({ content: "So you said you were researching ocean mammals?", name: "Bot", id: "3" }));
messages.push(new HumanMessage({ content: "Yes, I know about whales. But what others should I learn about?", name: "Lance", id: "4" }));

// Isolate messages to delete
const deleteMessages = messages.slice(0, -2).map((m) => new RemoveMessage({ id: m.id }));
console.log(deleteMessages);
// Output: [RemoveMessage { content: '', id: '1' }, RemoveMessage { content: '', id: '2' }]
```

Because the context window for chat model is denominated in tokens, it can be useful to trim message lists based upon some number of tokens that we want to retain. To do this, we can use [`trimMessages`](https://js.langchain.com/docs/how_to/trim_messages/#trimming-based-on-token-count) and specify number of token to keep from the list, as well as the `strategy` (e.g., keep the last `max_tokens`). 

```typescript
import { trimMessages } from "@langchain/core/messages";

trimMessages(
    messages,
    {
        // Keep the last <= n_count tokens of the messages.
        strategy: "last",
        // Remember to adjust based on your model
        // or else pass a custom token_encoder
        tokenCounter: new ChatOpenAI({ model: "gpt-4o" }),
        // Most chat models expect that chat history starts with either:
        // (1) a HumanMessage or
        // (2) a SystemMessage followed by a HumanMessage
        // Remember to adjust based on the desired conversation
        // length
        maxTokens: 45,
        // Most chat models expect that chat history starts with either:
        // (1) a HumanMessage or
        // (2) a SystemMessage followed by a HumanMessage
        startOn: "human",
        // Most chat models expect that chat history ends with either:
        // (1) a HumanMessage or
        // (2) a ToolMessage
        endOn: ["human", "tool"],
        // Usually, we want to keep the SystemMessage
        // if it's present in the original history.
        // The SystemMessage has special instructions for the model.
        includeSystem: true,
    }
)
```

### Usage with LangGraph

When building agents in LangGraph, we commonly want to manage a list of messages in the graph state. Because this is such a common use case, [MessagesAnnotation](/langgraphjs/concepts/low_level/#messagesannotation) is a built-in LangGraph state schema that includes a `messages` key, which is a list of messages. `MessagesAnnotation` also includes an `addMessages` reducer for updating the messages list with new messages as the application runs. The `addMessages` reducer allows us to [append](/langgraphjs/concepts/low_level/#reducers) new messages to the `messages` state key as shown below. When we perform a state update with `{ messages: newMessage }` returned from `myNode`, the `addMessages` reducer appends `newMessage` to the existing list of messages.

```typescript
const myNode = (state: typeof MessagesAnnotation.State) => {
    // Add a new message to the state
    const newMessage = new HumanMessage({ content: "message" });
    return { messages: newMessage };
};
```

The `addMessages` reducer built into `MessagesAnnotation` [also works with the `RemoveMessage` utility that we discussed above](/langgraphjs/how-tos/delete-messages/). In this case, we can perform a state update with a list of `deleteMessages` to remove specific messages from the `messages` list.

```typescript
const myNode = (state: typeof MessagesAnnotation.State) => {
    // Delete messages from state
    const deleteMessages = state.messages.slice(0, -2).map((m) => new RemoveMessage({ id: m.id }));
    return { messages: deleteMessages };
};
```

See this how-to [guide](/langgraphjs/how-tos/manage-conversation-history/) and module 2 from our [LangChain Academy](https://github.com/langchain-ai/langchain-academy/tree/main/module-2) course for example usage.

## Summarizing Past Conversations

The problem with trimming or removing messages, as shown above, is that we may loose information from culling of the message queue. Because of this, some applications benefit from a more sophisticated approach of summarizing the message history using a chat model. 

Simple prompting and orchestration logic can be used to achieve this. As an example, in LangGraph we can extend the [MessagesAnnotation](/langgraphjs/concepts/low_level/#messagesannotation) to include a `summary` key. 

```typescript
import { MessagesAnnotation, Annotation } from "@langchain/langgraph";

const MyGraphAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec,
    summary: Annotation<string>
})
```

Then, we can generate a summary of the chat history, using any existing summary as context for the next summary. This `summarize_conversation` node can be called after some number of messages have accumulated in the `messages` state key.

```typescript
import { ChatOpenAI } from "@langchain/openai";

const summarizeConversation = async (state: typeof MyGraphAnnotation.State) => {
  // First, we get any existing summary
  const summary = state.summary || "";

  // Create our summarization prompt 
  const summaryMessage = summary
    ? `This is summary of the conversation to date: ${summary}\n\n` +
      "Extend the summary by taking into account the new messages above:"
    : "Create a summary of the conversation above:";

  // Add prompt to our history
  const messages = [...state.messages, new HumanMessage({ content: summaryMessage })];
  
  // Assuming you have a ChatOpenAI model instance
  const model = new ChatOpenAI();
  const response = await model.invoke(messages);

  // Delete all but the 2 most recent messages
  const deleteMessages = state.messages.slice(0, -2).map(m => new RemoveMessage({ id: m.id }));

  return {
    summary: response.content,
    messages: deleteMessages
  };
}
```

See this how-to [here](/langgraphjs/how-tos/add-summary-conversation-history/) and module 2 from our [LangChain Academy](https://github.com/langchain-ai/langchain-academy/tree/main/module-2) course for example usage.

## Few Shot Examples

Few-shot learning is a powerful technique where LLMs can be ["programmed"](https://x.com/karpathy/status/1627366413840322562) inside the prompt with input-output examples to perform diverse tasks. While various [best-practices](https://js.langchain.com/docs/concepts/#1-generating-examples) can be used to generate few-shot examples, often the challenge lies in selecting the most relevant examples based on user input. 

LangChain [`ExampleSelectors`](https://js.langchain.com/docs/how_to/#example-selectors) can be used to customize few-shot example selection from a collection of examples using criteria such as length, semantic similarity, semantic ngram overlap, or maximal marginal relevance.

If few-shot examples are stored in a [LangSmith Dataset](https://docs.smith.langchain.com/how_to_guides/datasets), then dynamic few-shot example selectors can be used out-of-the box to achieve this same goal. LangSmith will index the dataset for you and enable retrieval of few shot examples that are most relevant to the user input based upon keyword similarity ([using a BM25-like algorithm](https://docs.smith.langchain.com/how_to_guides/datasets/index_datasets_for_dynamic_few_shot_example_selection) for keyword based similarity). 

See this how-to [video](https://www.youtube.com/watch?v=37VaU7e7t5o) for example usage of dynamic few-shot example selection in LangSmith. Also, see this [blog post](https://blog.langchain.dev/few-shot-prompting-to-improve-tool-calling-performance/) showcasing few-shot prompting to improve tool calling performance and this [blog post](https://blog.langchain.dev/aligning-llm-as-a-judge-with-human-preferences/) using few-shot example to align an LLMs to human preferences.

## Maintaining Data Across Chat Sessions

LangGraph's [persistence layer](/langgraphjs/concepts/persistence/#persistence) has checkpointers that utilize various storage systems, including an in-memory key-value store or different databases. These checkpoints capture the graph state at each execution step and accumulate in a thread, which can be accessed at a later time using a thread ID to resume a previous graph execution. We add persistence to our graph by passing a checkpointer to the `compile` method, as shown here.

```typescript
import { MemorySaver } from "@langchain/langgraph";

// Compile the graph with a checkpointer
const checkpointer = new MemorySaver();
const graph = workflow.compile({ checkpointer });

// Invoke the graph with a thread ID
const config = { configurable: { thread_id: "1" } };
await graph.invoke(inputState, config);

// get the latest state snapshot at a later time
const latestState = await graph.getState(config);
```

Persistence is critical sustaining a long-running chat sessions. For example, a chat between a user and an AI assistant may have interruptions. Persistence ensures that a user can continue that particular chat session at any later point in time. However, what happens if a user initiates a new chat session with an assistant? This spawns a new thread, and the information from the previous session (thread) is not retained. This motivates the need for a memory service that can maintain data across chat sessions (threads). 

## Meta-prompting

Meta-prompting uses an LLM to generate or refine its own prompts or instructions. This approach allows the system to dynamically update and improve its own behavior, potentially leading to better performance on various tasks. This is particularly useful for tasks where the instructions are challenging to specify a priori. 

Meta-prompting can use past information to update the prompt. As an example, this [Tweet generator](https://www.youtube.com/watch?v=Vn8A3BxfplE) uses meta-prompting to iteratively improve the summarization prompt used to generate high quality paper summaries for Twitter. In this case, we used a LangSmith dataset to house several papers that we wanted to summarize, generated summaries using a naive summarization prompt, manually reviewed the summaries, captured feedback from human review using the LangSmith Annotation Queue, and passed this feedback to a chat model to re-generate the summarization prompt. The process was repeated in a loop until the summaries met our criteria in human review.

## Retrieving relevant information from long-term storage

A central challenge that spans many different memory use-case can be summarized simply: how can we retrieve *relevant information* from a long-term storage system and pass it to a chat model? As an example, assume we have a system that stores a large number of specific details about a user, but the user asks a specific question related to restaurant recommendations. It would be costly to trivially extract *all* personal user information and pass it to a chat model. Instead, we want to extract only the information that is most relevant to the user's current chat interaction (e,g,. food preferences, location, etc.) and pass it to the chat model. 

There is a large body of work on retrieval that aims to address this challenge. See our conceptual docs on [retrieval](https://js.langchain.com/docs/concepts/#retrieval), and our [open source repository](https://github.com/langchain-ai/rag-from-scratch) along with [videos](https://www.youtube.com/playlist?list=PLfaIDFEXuae2LXbO1_PKyVJiQ23ZztA0x) on this topic.