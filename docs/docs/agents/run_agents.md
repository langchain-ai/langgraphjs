# Running agents


Agents support execution using either `.invoke()` for full responses, or `.stream()` for **incremental** [streaming](#streaming-output) of the output. This section explains how to provide input, interpret output, enable streaming, and control execution limits.


## Basic usage

Agents can be executed using `.invoke()`:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = createReactAgent(...);

// highlight-next-line
const response = await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] }
);
```

## Inputs and outputs

Agents use a language model that expects a list of `messages` as an input. Therefore, agent inputs and outputs are stored as a list of `messages` under the `messages` key in the agent [state](../concepts/low_level.md#working-with-messages-in-graph-state).

## Input format

Agent input must be an object with a `messages` key. Supported formats are:

| Format             | Example                                                                                                                       |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------|
| String             | `{ messages: "Hello" }`  — Interpreted as a [HumanMessage](https://js.langchain.com/docs/concepts/messages/#humanmessage) |
| Message object | `{ messages: { "role": "user", "content": "Hello" } }`                                                                          |
| List of messages   | `{ messages: [ {"role": "user", "content": "Hello" } ] }`                                                                        |
| With custom state  | `{ messages: [ {"role": "user", "content": "Hello"} ], "user_name": "Alice" }` — If using a custom `stateSchema`               |

Messages are automatically converted into LangChain's internal message format. You can read
more about [LangChain messages](https://js.langchain.com/docs/concepts/messages/#langchain-messages) in the LangChain documentation.

!!! tip "Using custom agent state"

    You can provide additional fields defined in your agent's state schema directly in the input dictionary. This allows dynamic behavior based on runtime data or prior tool outputs.  
    See the [context guide](./context.md) for full details.

!!! note

    A string input for `messages` is converted to a [HumanMessage](https://js.langchain.com/docs/concepts/messages/#humanmessage). This behavior differs from the `prompt` parameter in `createReactAgent`, which is interpreted as a [SystemMessage](https://js.langchain.com/docs/concepts/messages/#systemmessage) when passed as a string.


## Output format

Agent output is a dictionary containing:

- `messages`: A list of all messages exchanged during execution (user input, assistant replies, tool invocations).
- Optionally, `structuredResponse` if [structured output](./agents.md#structured-output) is configured.
- If using a custom `stateSchema`, additional keys corresponding to your defined fields may also be present in the output. These can hold updated state values from tool execution or prompt logic.

See the [context guide](./context.md) for more details on working with custom state schemas and accessing context.

## Streaming output

Agents support streaming responses for more responsive applications. This includes:

- **Progress updates** after each step
- **LLM tokens** as they're generated
- **Custom tool messages** during execution

Streaming is available in both sync and async modes:

```ts
for await (
  const chunk of await agent.stream(
    { messages: [ { role: "user", content: "what is the weather in sf" } ] },
    { streamMode: "updates" },
  )
) {
  console.log(chunk);
}
```

!!! tip

    For full details, see the [streaming guide](./streaming.md).

## Max iterations

To control agent execution and avoid infinite loops, set a recursion limit. This defines the maximum number of steps the agent can take before raising a `GraphRecursionError`. You can configure `recursionLimit` at runtime or when defining agent via `.withConfig()`:

=== "Runtime"

    ```ts
    import { GraphRecursionError } from "@langchain/langgraph";
    import { createReactAgent } from "@langchain/langgraph/prebuilt";
    import { initChatModel } from "langchain/chat_models/universal";

    const maxIterations = 3;
    // highlight-next-line
    const recursionLimit = 2 * maxIterations + 1;
    const llm = await initChatModel("anthropic:claude-3-5-haiku-latest");
    const agent = createReactAgent({
      llm,
      tools: [getWeather]
    });

    try {
      const response = await agent.invoke(
        { messages: [ { role: "user", content: "what's the weather in sf" } ] },
        // highlight-next-line
        { recursionLimit }
      );
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        console.log("Agent stopped due to max iterations.");
      } else {
        throw error;
      }
    }
    ```

=== "`.withConfig()`"

    ```ts
    import { GraphRecursionError } from "@langchain/langgraph";
    import { createReactAgent } from "@langchain/langgraph/prebuilt";
    import { initChatModel } from "langchain/chat_models/universal";

    const maxIterations = 3;
    // highlight-next-line
    const recursionLimit = 2 * maxIterations + 1;
    const llm = await initChatModel("anthropic:claude-3-5-haiku-latest");
    const agent = createReactAgent({
      llm,
      tools: [getWeather]
    });
    // highlight-next-line
    const agentWithRecursionLimit = agent.withConfig({ recursionLimit });

    try {
      const response = await agentWithRecursionLimit.invoke(
        { messages: [ { role: "user", content: "what's the weather in sf" } ] }
      );
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        console.log("Agent stopped due to max iterations.");
      } else {
        throw error;
      }
    }
    ```
