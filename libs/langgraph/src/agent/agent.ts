import { LanguageModelLike } from "@langchain/core/language_models/base";
import { type RunnableToolLike } from "@langchain/core/runnables";
import type {
  DynamicTool,
  StructuredToolInterface,
} from "@langchain/core/tools";
import { ToolNode } from "../prebuilt";
import { Annotation, StateGraph } from "../graph";
import { END, MessagesAnnotation, START } from "../web";
import {
  BaseMessage,
  isAIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { unknown } from "zod/v4";
import {
  BaseChatModel,
  ToolChoice,
} from "@langchain/core/language_models/chat_models";
import { EphemeralValue } from "../channels/ephemeral_value";

type Tool = StructuredToolInterface | DynamicTool | RunnableToolLike;

export const AgentState = Annotation.Root({
  messages: MessagesAnnotation["spec"]["messages"],
  jumpTo: new EphemeralValue<"tools" | "model" | "__end__">(),
  response: Annotation<Record<string, unknown> | undefined>(),
});

export type AgentState = typeof AgentState;

const isToolReturnDirect = (tool: Tool) =>
  "returnDirect" in tool && tool.returnDirect;

export interface AgentMiddleware {
  name: string;
  beforeModel?: (
    state: AgentState["State"]
  ) => Promise<AgentState["Update"]> | AgentState["Update"];
  afterModel?: (
    state: AgentState["State"]
  ) => Promise<AgentState["Update"]> | AgentState["Update"];
  modifyModelRequest?: (request: ModelRequest) => ModelRequest;
}

function isBaseChatModel(model: LanguageModelLike): model is BaseChatModel {
  return (
    "invoke" in model &&
    typeof model.invoke === "function" &&
    "_modelType" in model
  );
}

function isChatModelWithBindTools(
  llm: LanguageModelLike
): llm is BaseChatModel & Required<Pick<BaseChatModel, "bindTools">> {
  if (!isBaseChatModel(llm)) return false;
  return "bindTools" in llm && typeof llm.bindTools === "function";
}

export interface ModelRequest {
  model: LanguageModelLike;
  systemPrompt?: string;
  messages: BaseMessage[];
  toolChoice: ToolChoice | undefined;
  middleware: AgentMiddleware[] | undefined;
  tools: Tool[];
}

export function createAgent(options: {
  model: LanguageModelLike;
  tools: Tool[] | ToolNode;
  systemPrompt?: string;
  middleware?: AgentMiddleware[];
}) {
  const middleware = options.middleware ?? [];

  // init tool node
  const toolNode = Array.isArray(options.tools)
    ? new ToolNode(options.tools)
    : options.tools;

  type MiddlewareMap = Record<
    string,
    (
      state: AgentState["State"]
    ) => Promise<AgentState["Update"]> | AgentState["Update"]
  >;

  const toolNodeBefore = middleware.reduce<MiddlewareMap>(
    (acc, { name, beforeModel }) => {
      if (beforeModel) acc[`${name}.beforeModel`] = beforeModel;
      return acc;
    },
    {}
  );

  const toolNodeAfter = middleware.reduce<MiddlewareMap>(
    (acc, { name, afterModel }) => {
      if (afterModel) acc[`${name}.afterModel`] = afterModel;
      return acc;
    },
    {}
  );

  const builder = new StateGraph(AgentState).addNode({
    ...toolNodeBefore,
    ...toolNodeAfter,

    modelRequest: async (state: AgentState["State"]) => {
      let request: ModelRequest = {
        model: options.model,
        messages: state.messages,
        toolChoice: unknown,
        tools: toolNode.tools,
        systemPrompt: options.systemPrompt,
        middleware: options.middleware,
      };

      for (const middleware of options.middleware ?? []) {
        if (middleware.modifyModelRequest != null) {
          request = middleware.modifyModelRequest(request);
        }
      }

      // prepare messages
      const messages =
        request.systemPrompt != null
          ? [new SystemMessage(request.systemPrompt), ...request.messages]
          : request.messages;

      // call model
      const model = isChatModelWithBindTools(request.model)
        ? request.model.bindTools(request.tools, {
            tool_choice: request.toolChoice,
          })
        : request.model;

      // TODO: add support for responseFormat
      const output = await model.invoke(messages);
      return { messages: output, response: undefined };
    },

    tools: toolNode,
  });

  const firstNode = Object.keys(toolNodeBefore).at(0) ?? "modelRequest";
  const lastNode = Object.keys(toolNodeAfter).at(0) ?? "modelRequest";

  builder.addEdge(START, firstNode);
  builder.addConditionalEdges(
    "tools",
    (state) => {
      const lastAiMessage = state.messages.filter(isAIMessage).at(-1);

      const shouldRedirectDirect = lastAiMessage?.tool_calls?.every((call) => {
        const tool = toolNode.tools.find((tool) => tool.name === call.name);
        if (!tool) return false;
        return isToolReturnDirect(tool);
      });

      if (shouldRedirectDirect) return END;
      return firstNode;
    },
    [firstNode, END]
  );
  builder.addConditionalEdges(
    lastNode,
    (state) => {
      if (state.jumpTo != null) {
        if (state.jumpTo === "model") return firstNode;
        return state.jumpTo;
      }

      const lastMessage = state.messages.at(-1);
      if (lastMessage != null && isAIMessage(lastMessage)) return "tools";
      return END;
    },
    ["tools", END]
  );

  if (middleware.length > 0) {
    // add before model edges
    for (let endIdx = 1; endIdx < middleware.length; endIdx += 1) {
      let startIdx = endIdx - 1;

      const startNode = `${middleware[startIdx].name}.beforeModel`;
      const endNode = `${middleware[endIdx].name}.beforeModel`;
      builder.addEdge(startNode, endNode);
    }
    builder.addEdge(`${middleware.at(-1)!.name}.beforeModel`, "modelRequest");

    // add after model edges
    for (let startIdx = middleware.length - 1; startIdx > 0; startIdx -= 1) {
      const startNode = `${middleware[startIdx].name}.afterModel`;
      const endNode = `${middleware[startIdx - 1].name}.afterModel`;
      builder.addEdge(startNode, endNode);
    }
    builder.addEdge(`modelRequest`, `${middleware.at(-1)!.name}.afterModel`);
  }

  return builder;
}
