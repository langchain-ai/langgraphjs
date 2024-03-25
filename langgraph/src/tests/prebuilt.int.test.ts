/* eslint-disable no-process-env */

import { it, beforeAll, describe, expect } from "@jest/globals";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  FunctionMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { convertToOpenAIFunction } from "@langchain/core/utils/function_calling";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import type { AgentAction } from "langchain/agents";
import { END, StateGraph } from "../index.js";
import {
  ToolExecutor,
  createFunctionCallingExecutor,
} from "../prebuilt/index.js";

// Tracing slows down the tests
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

describe("createFunctionCallingExecutor", () => {
  it("can call a function", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI();
    class SanFranciscoWeatherTool extends Tool {
      name = "current_weather";

      description = "Get the current weather report for San Francisco, CA";

      constructor() {
        super();
      }

      async _call(_: string): Promise<string> {
        return weatherResponse;
      }
    }
    const tools = [new SanFranciscoWeatherTool()];

    const functionsAgentExecutor = createFunctionCallingExecutor<ChatOpenAI>({
      model,
      tools,
    });

    const response = await functionsAgentExecutor.invoke({
      messages: [new HumanMessage("What's the weather like in SF?")],
    });

    console.log(response);
    // It needs at least one human message, one AI and one function message.
    expect(response.messages.length > 3).toBe(true);
    const firstFunctionMessage = (response.messages as Array<BaseMessage>).find(
      (message) => message._getType() === "function"
    );
    expect(firstFunctionMessage).toBeDefined();
    expect(firstFunctionMessage?.content).toBe(weatherResponse);
  });

  it("can stream a function", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI({
      streaming: true,
    });
    class SanFranciscoWeatherTool extends Tool {
      name = "current_weather";

      description = "Get the current weather report for San Francisco, CA";

      constructor() {
        super();
      }

      async _call(_: string): Promise<string> {
        return weatherResponse;
      }
    }
    const tools = [new SanFranciscoWeatherTool()];

    const functionsAgentExecutor = createFunctionCallingExecutor<ChatOpenAI>({
      model,
      tools,
    });

    const stream = await functionsAgentExecutor.stream({
      messages: [new HumanMessage("What's the weather like in SF?")],
    });
    const fullResponse = [];
    for await (const item of stream) {
      console.log(item);
      console.log("-----\n");
      fullResponse.push(item);
    }

    // Needs at least 3 llm calls, plus one `__end__` call.
    expect(fullResponse.length >= 4).toBe(true);

    const endMessage = fullResponse[fullResponse.length - 1];
    expect(END in endMessage).toBe(true);
    expect(endMessage[END].messages.length > 0).toBe(true);

    const functionCall = endMessage[END].messages.find(
      (message: BaseMessage) => message._getType() === "function"
    );
    expect(functionCall.content).toBe(weatherResponse);
  });
});

describe("createAgentExecutor", () => {
  it("Can stream events", async () => {
    const tools = [new TavilySearchResults({ maxResults: 3 })];
    const toolExecutor = new ToolExecutor({ tools });
    const model = new ChatOpenAI({
      temperature: 0,
      streaming: true,
    });

    const toolsAsOpenAIFunctions = tools.map((tool) =>
      convertToOpenAIFunction(tool)
    );
    const newModel = model.bind({
      functions: toolsAsOpenAIFunctions,
    });
    const agentState = {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    };
    // Define the function that determines whether to continue or not
    const shouldContinue = (state: { messages: Array<BaseMessage> }) => {
      const { messages } = state;
      const lastMessage = messages[messages.length - 1];
      // If there is no function call, then we finish
      if (
        !("function_call" in lastMessage.additional_kwargs) ||
        !lastMessage.additional_kwargs.function_call
      ) {
        return "end";
      }
      // Otherwise if there is, we continue
      return "continue";
    };

    // Define the function to execute tools
    const _getAction = (state: {
      messages: Array<BaseMessage>;
    }): AgentAction => {
      const { messages } = state;
      // Based on the continue condition
      // we know the last message involves a function call
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) {
        throw new Error("No messages found.");
      }
      if (!lastMessage.additional_kwargs.function_call) {
        throw new Error("No function call found in message.");
      }
      // We construct an AgentAction from the function_call
      return {
        tool: lastMessage.additional_kwargs.function_call.name,
        toolInput: JSON.parse(
          lastMessage.additional_kwargs.function_call.arguments
        ),
        log: "",
      };
    };

    // Define the function that calls the model
    const callModel = async (state: { messages: Array<BaseMessage> }) => {
      const { messages } = state;
      // You can use a prompt here to tweak model behavior.
      // You can also just pass messages to the model directly.
      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a helpful assistant."],
        new MessagesPlaceholder("messages"),
      ]);
      const response = await prompt.pipe(newModel).invoke({ messages });
      // We return a list, because this will get added to the existing list
      return {
        messages: [response],
      };
    };

    const callTool = async (state: { messages: Array<BaseMessage> }) => {
      const action = _getAction(state);
      // We call the tool_executor and get back a response
      const response = await toolExecutor.invoke(action);
      // We use the response to create a FunctionMessage
      const functionMessage = new FunctionMessage({
        content: response,
        name: action.tool,
      });
      // We return a list, because this will get added to the existing list
      return { messages: [functionMessage] };
    };

    // Define a new graph
    const workflow = new StateGraph({
      channels: agentState,
    });

    // Define the two nodes we will cycle between
    workflow.addNode("agent", callModel);
    workflow.addNode("action", callTool);

    // Set the entrypoint as `agent`
    // This means that this node is the first one called
    workflow.setEntryPoint("agent");

    // We now add a conditional edge
    workflow.addConditionalEdges(
      // First, we define the start node. We use `agent`.
      // This means these are the edges taken after the `agent` node is called.
      "agent",
      // Next, we pass in the function that will determine which node is called next.
      shouldContinue,
      // Finally we pass in a mapping.
      // The keys are strings, and the values are other nodes.
      // END is a special node marking that the graph should finish.
      // What will happen is we will call `should_continue`, and then the output of that
      // will be matched against the keys in this mapping.
      // Based on which one it matches, that node will then be called.
      {
        // If `tools`, then we call the tool node.
        continue: "action",
        // Otherwise we finish.
        end: END,
      }
    );

    // We now add a normal edge from `tools` to `agent`.
    // This means that after `tools` is called, `agent` node is called next.
    workflow.addEdge("action", "agent");

    // Finally, we compile it!
    // This compiles it into a LangChain Runnable,
    // meaning you can use it as you would any other runnable
    const app = workflow.compile();

    const inputs = {
      messages: [new HumanMessage("what is the weather in sf")],
    };
    const stream = await app.streamEvents(inputs, {
      version: "v1",
    });
    for await (const chunk of stream) {
      console.log(chunk);
    }
  });
});
