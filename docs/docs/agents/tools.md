# Tools

[Tools](https://js.langchain.com/docs/concepts/tools/) are a way to encapsulate a function and its input schema in a way that can be passed to a chat model that supports tool calling. This allows the model to request the execution of this function with specific inputs.

You can either [define your own tools](#define-tools) or use [prebuilt integrations](#prebuilt-tools) that LangChain provides.

## Define tools

You create tools using the [`tool`](https://api.js.langchain.com/functions/_langchain_core.tools.tool-1.html) function:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
// highlight-next-line
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const multiply = tool(
  async (input: { a: number; b: number }) => {
    return input.a * input.b;
  },
  {
    name: "multiply",
    schema: z.object({
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    }),
    description: "Multiply two numbers.",
  }
);

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [multiply],
});
```

For additional customization, refer to the [custom tools guide](https://js.langchain.com/docs/how_to/custom_tools/).

## Hide arguments from the model

Some tools require runtime-only arguments (e.g., user ID or session context) that should not be controllable by the model.

You can put these arguments in the `state` or `config` of the agent, and access
this information inside the tool:

```ts
import { z } from "zod";
import { tool } from "@langchain/core/tools";
// highlight-next-line
import {
  // highlight-next-line
  getCurrentTaskInput,
  // highlight-next-line
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";

const myTool = tool(
  async (
    input: {
      // This will be populated by an LLM
      toolArg: string;
    },
    // access static data that is passed at agent invocation
    // highlight-next-line
    config: LangGraphRunnableConfig
  ) => {
    // Fetch the current agent state
    // highlight-next-line
    const state = getCurrentTaskInput() as typeof MessagesAnnotation.State;
    doSomethingWithState(state.messages);
    doSomethingWithConfig(config);
    // ...
  },
  {
    name: "myTool",
    schema: z.object({
      myToolArg: z.number().describe("Tool arg"),
    }),
    description: "My tool.",
  }
);
```

## Disable parallel tool calling

Some model providers support executing multiple tools in parallel, but
allow users to disable this feature.

For supported providers, you can disable parallel tool calling by setting `parallel_tool_calls: false` via the `model.bindTools()` method:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const add = tool(
  async (input: { a: number; b: number }) => {
    return input.a + input.b;
  },
  {
    name: "add",
    schema: z.object({
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    }),
    description: "Add two numbers.",
  }
);

const multiply = tool(
  async (input: { a: number; b: number }) => {
    return input.a * input.b;
  },
  {
    name: "multiply",
    schema: z.object({
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    }),
    description: "Multiply two numbers.",
  }
);

const llm = new ChatOpenAI({ model: "gpt-4.1" });

const tools = [add, multiply];
const agent = createReactAgent({
  // disable parallel tool calls
  // highlight-next-line
  llm: llm.bindTools(tools, { parallel_tool_calls: false }),
  tools,
});

const response = await agent.invoke({
  messages: [{ role: "user", content: "what's 3 + 5 and 4 * 7?" }],
});
```

## Return tool results directly

Use `returnDirect: true` to return tool results immediately and stop the agent loop:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const add = tool(
  async (input: { a: number; b: number }) => {
    return input.a + input.b;
  },
  {
    name: "add",
    schema: z.object({
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    }),
    description: "Add two numbers.",
    // highlight-next-line
    returnDirect: true,
  }
);

const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
const agent = createReactAgent({
  llm,
  tools: [add],
});

const response = await agent.invoke({
  messages: [{ role: "user", content: "what's 3 + 5?" }],
});
```

## Force tool use

To force the agent to use specific tools, you can set the `tool_choice` option in `model.bindTools()`:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const greet = tool(
  async (input: { userName: string }) => {
    return `Hello ${input.userName}!`;
  },
  {
    name: "greet",
    schema: z.object({
      userName: z.string().describe("Name of the user to greet"),
    }),
    description: "Greet user.",
    // highlight-next-line
    returnDirect: true,
  }
);

const llm = new ChatAnthropic({ model: "claude-3-7-sonnet-latest" });
const tools = [greet];

const agent = createReactAgent({
  // highlight-next-line
  llm: llm.bindTools(tools, { tool_choice: { type: "tool", name: "greet" } }),
  tools,
});

const response = await agent.invoke({
  messages: "Hi, I am Bob",
});
```

!!! Warning "Avoid infinite loops"

    Forcing tool usage without stopping conditions can create infinite loops. Use one of the following safeguards:

    - Mark the tool with [`returnDirect: True`](#return-tool-results-directly) to end the loop after execution.
    - Set [`recursionLimit`](../concepts/low_level.md#recursion-limit) to restrict the number of execution steps.

## Handle tool errors

By default, the agent will catch all exceptions raised during tool calls and will pass those as tool messages to the LLM. To control how the errors are handled, you can use the prebuilt [`ToolNode`](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph_prebuilt.ToolNode.html) — the node that executes tools inside `createReactAgent` — via its `handleToolErrors` parameter:

=== "Enable error handling (default)"

    ```ts
    import { createReactAgent } from "@langchain/langgraph/prebuilt";
    import { initChatModel } from "langchain/chat_models/universal";
    import { tool } from "@langchain/core/tools";
    import { z } from "zod";

    const multiply = tool(
      async (input: { a: number; b: number }) => {
        if (input.a === 42) {
          throw new Error("The ultimate error");
        }
        return input.a * input.b;
      },
      {
        name: "multiply",
        schema: z.object({
          a: z.number().describe("First operand"),
          b: z.number().describe("Second operand"),
        }),
        description: "Multiply two numbers.",
      }
    );

    // Run with error handling (default)
    const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
    const agent = createReactAgent({
      llm,
      tools: [multiply],
    });

    const response = await agent.invoke(
      { messages: [ { role: "user", content: "what's 42 x 7?" } ] }
    );
    ```

=== "Disable error handling"

    ```ts
    import { createReactAgent } from "@langchain/langgraph/prebuilt";
    import { initChatModel } from "langchain/chat_models/universal";
    import { tool } from "@langchain/core/tools";
    import { z } from "zod";
    import { ToolNode } from "@langchain/langgraph/prebuilt";

    const multiply = tool(
      async (input: { a: number; b: number }) => {
        if (input.a === 42) {
          throw new Error("The ultimate error");
        }
        return input.a * input.b;
      },
      {
        name: "multiply",
        schema: z.object({
          a: z.number().describe("First operand"),
          b: z.number().describe("Second operand"),
        }),
        description: "Multiply two numbers.",
      }
    );

    // highlight-next-line
    const toolNode = new ToolNode({
      tools: [multiply],
      // highlight-next-line
      handleToolErrors: false, // (1)!
    });

    const llm = await initChatModel("anthropic:claude-3-7-sonnet-latest");
    const agentNoErrorHandling = createReactAgent({
      llm,
      tools: toolNode,
    });

    const response = await agentNoErrorHandling.invoke(
      { messages: [ { role: "user", content: "what's 42 x 7?" } ] }
    );
    ```

    1. This disables error handling (enabled by default).

## Prebuilt tools

You can use prebuilt tools from model providers by passing a dictionary with tool specs to the `tools` parameter of `createReactAgent`. For example, to use the `web_search_preview` tool from OpenAI:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";

const llm = await initChatModel("openai:gpt-4o-mini");

const agent = createReactAgent({
  llm,
  tools: [{ type: "web_search_preview" }],
});

const response = await agent.invoke({
  messages: ["What was a positive news story from today?"],
});
```

Additionally, LangChain supports a wide range of prebuilt tool integrations for interacting with APIs, databases, file systems, web data, and more. These tools extend the functionality of agents and enable rapid development.

You can browse the full list of available integrations in the [LangChain integrations directory](https://js.langchain.com/docs/integrations/tools/).

Some commonly used tool categories include:

- **Search**: Exa, SerpAPI, Tavily
- **Code interpreters**: Python REPL
- **Databases**: SQL, MongoDB, Redis
- **Web data**: Web scraping and browsing
- **APIs**: Discord, Gmail, and others

These integrations can be configured and added to your agents using the same `tools` parameter shown in the examples above.
