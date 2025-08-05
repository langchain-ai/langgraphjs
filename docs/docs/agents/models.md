# Models

This page describes how to configure the chat model used by an agent.

## Tool calling support

To enable tool-calling agents, the underlying LLM must support [tool calling](https://js.langchain.com/docs/concepts/tool_calling/).

Compatible models can be found in the [LangChain integrations directory](https://js.langchain.com/docs/integrations/chat/).

## Using `initChatModel`

The [`initChatModel`](https://js.langchain.com/docs/how_to/chat_models_universal_init/) utility simplifies model initialization with configurable parameters:

```ts
import { initChatModel } from "langchain/chat_models/universal";

const llm = await initChatModel(
  "anthropic:claude-3-7-sonnet-latest",
  {
    temperature: 0,
    maxTokens: 2048
  }
);
```

Refer to the [API reference](https://api.js.langchain.com/functions/langchain.chat_models_universal.initChatModel.html) for advanced options.

## Using provider-specific LLMs 

If a model provider is not available via `initChatModel`, you can instantiate the provider's model class directly. The model must implement the [`BaseChatModel`](https://api.js.langchain.com/classes/_langchain_core.language_models_chat_models.BaseChatModel.html) interface and support tool calling:

```ts
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

// highlight-next-line
const llm = new ChatAnthropic({
  modelName: "claude-3-7-sonnet-latest",
  temperature: 0,
  maxTokens: 2048
});

const agent = createReactAgent({
  // highlight-next-line
  llm,
  // other parameters
});
```

!!! note "Illustrative example" 

    The example above uses `ChatAnthropic`, which is already supported by `initChatModel`. This pattern is shown to illustrate how to manually instantiate a model not available through `initChatModel`.

## Additional resources

- [Model integration directory](https://js.langchain.com/docs/integrations/chat/)
- [Universal initialization with `initChatModel`](https://js.langchain.com/docs/how_to/chat_models_universal_init/)