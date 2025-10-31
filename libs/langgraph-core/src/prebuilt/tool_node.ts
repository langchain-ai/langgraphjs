/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { BaseMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { RunnableConfig, RunnableToolLike } from "@langchain/core/runnables";
import {
  DynamicTool,
  StructuredToolInterface,
  ToolInputParsingException,
} from "@langchain/core/tools";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { InteropZodObject } from "@langchain/core/utils/types";
import { RunnableCallable } from "../utils.js";
import { AnnotationRoot } from "../graph/annotation.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { isGraphInterrupt } from "../errors.js";
import { END, isCommand, Command, Send, _isSend } from "../constants.js";
import { combineAbortSignals } from "../pregel/utils/index.js";

export interface ToolNodeOptions {
  /**
   * The name of the tool node.
   */
  name?: string;
  /**
   * The tags to add to the tool call.
   */
  tags?: string[];
  /**
   * The abort signal to cancel the tool call.
   */
  signal?: AbortSignal;
  /**
   * Whether to throw the error immediately if the tool fails or handle it by the `onToolError` function or via ToolMessage.
   *
   * If `true` (default):
   *   - a tool message with the error will be returned to the LLM
   *
   * If `false`:
   *   - the error will be thrown immediately
   *
   * If a function is provided:
   *   - returns a custom {@link ToolMessage} as result
   *   - throws an error otherwise
   *
   * @default true
   */
  handleToolErrors?:
    | boolean
    | ((error: unknown, toolCall: ToolCall) => ToolMessage | undefined);
}

// Define types for annotation compatibility
export type AnyAnnotationRoot = AnnotationRoot<any>;

/**
 * Raised when a tool call is throwing an error.
 */
export class ToolInvocationError extends Error {
  public readonly toolCall: ToolCall;

  public readonly toolError: Error;

  constructor(toolError: unknown, toolCall: ToolCall) {
    const error =
      toolError instanceof Error ? toolError : new Error(String(toolError));
    const toolArgs = JSON.stringify(toolCall.args);
    super(
      `Error invoking tool '${toolCall.name}' with kwargs ${toolArgs} with error: ${error.stack}\n Please fix the error and try again.`
    );

    this.toolCall = toolCall;
    this.toolError = error;
  }
}

// Create a mergeAbortSignals function since the import might not work
function mergeAbortSignals(
  signal1?: AbortSignal,
  signal2?: AbortSignal
): AbortSignal | undefined {
  if (!signal1 && !signal2) return undefined;
  if (!signal1) return signal2;
  if (!signal2) return signal1;

  const { signal } = combineAbortSignals(signal1, signal2);
  return signal;
}

const isBaseMessageArray = (input: unknown): input is BaseMessage[] =>
  Array.isArray(input) && input.every(BaseMessage.isInstance);

const isMessagesState = (
  input: unknown
): input is { messages: BaseMessage[] } =>
  typeof input === "object" &&
  input != null &&
  "messages" in input &&
  isBaseMessageArray(input.messages);

const isSendInput = (input: unknown): input is { lg_tool_call: ToolCall } =>
  typeof input === "object" && input != null && "lg_tool_call" in input;

/**
 * A node that runs the tools requested in the last AIMessage. It can be used
 * either in StateGraph with a "messages" key or in MessageGraph. If multiple
 * tool calls are requested, they will be run in parallel. The output will be
 * a list of ToolMessages, one for each tool call.
 *
 * @example
 * ```ts
 * import { ToolNode } from "@langchain/langgraph/prebuilt";
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { AIMessage } from "@langchain/core/messages";
 *
 * const getWeather = tool((input) => {
 *   if (["sf", "san francisco"].includes(input.location.toLowerCase())) {
 *     return "It's 60 degrees and foggy.";
 *   } else {
 *     return "It's 90 degrees and sunny.";
 *   }
 * }, {
 *   name: "get_weather",
 *   description: "Call to get the current weather.",
 *   schema: z.object({
 *     location: z.string().describe("Location to get the weather for."),
 *   }),
 * });
 *
 * const tools = [getWeather];
 * const toolNode = new ToolNode(tools);
 *
 * const messageWithSingleToolCall = new AIMessage({
 *   content: "",
 *   tool_calls: [
 *     {
 *       name: "get_weather",
 *       args: { location: "sf" },
 *       id: "tool_call_id",
 *       type: "tool_call",
 *     }
 *   ]
 * })
 *
 * await toolNode.invoke({ messages: [messageWithSingleToolCall] });
 * // Returns tool invocation responses as:
 * // { messages: ToolMessage[] }
 * ```
 *
 * @example
 * ```ts
 * import {
 *   StateGraph,
 *   MessagesAnnotation,
 * } from "@langchain/langgraph";
 * import { ToolNode } from "@langchain/langgraph/prebuilt";
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * const getWeather = tool((input) => {
 *   if (["sf", "san francisco"].includes(input.location.toLowerCase())) {
 *     return "It's 60 degrees and foggy.";
 *   } else {
 *     return "It's 90 degrees and sunny.";
 *   }
 * }, {
 *   name: "get_weather",
 *   description: "Call to get the current weather.",
 *   schema: z.object({
 *     location: z.string().describe("Location to get the weather for."),
 *   }),
 * });
 *
 * const tools = [getWeather];
 * const modelWithTools = new ChatAnthropic({
 *   model: "claude-3-haiku-20240307",
 *   temperature: 0
 * }).bindTools(tools);
 *
 * const toolNodeForGraph = new ToolNode(tools)
 *
 * const shouldContinue = (state: typeof MessagesAnnotation.State) => {
 *   const { messages } = state;
 *   const lastMessage = messages[messages.length - 1];
 *   if ("tool_calls" in lastMessage && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls?.length) {
 *     return "tools";
 *   }
 *   return "__end__";
 * }
 *
 * const callModel = async (state: typeof MessagesAnnotation.State) => {
 *   const { messages } = state;
 *   const response = await modelWithTools.invoke(messages);
 *   return { messages: response };
 * }
 *
 * const graph = new StateGraph(MessagesAnnotation)
 *   .addNode("agent", callModel)
 *   .addNode("tools", toolNodeForGraph)
 *   .addEdge("__start__", "agent")
 *   .addConditionalEdges("agent", shouldContinue)
 *   .addEdge("tools", "agent")
 *   .compile();
 *
 * const inputs = {
 *   messages: [{ role: "user", content: "what is the weather in SF?" }],
 * };
 *
 * const stream = await graph.stream(inputs, {
 *   streamMode: "values",
 * });
 *
 * for await (const { messages } of stream) {
 *   console.log(messages);
 * }
 * // Returns the messages in the state at each step of execution
 * ```
 */
export class ToolNode<
  StateSchema extends AnyAnnotationRoot | InteropZodObject = any,
  ContextSchema extends AnyAnnotationRoot | InteropZodObject = any
> extends RunnableCallable<StateSchema, ContextSchema> {
  tools: (StructuredToolInterface | DynamicTool | RunnableToolLike)[];

  trace = false;

  signal?: AbortSignal;

  handleToolErrors:
    | boolean
    | ((error: unknown, toolCall: ToolCall) => ToolMessage | undefined) = true;

  constructor(
    tools: (StructuredToolInterface | DynamicTool | RunnableToolLike)[],
    public options?: ToolNodeOptions
  ) {
    const { name, tags, handleToolErrors } = options ?? {};
    super({
      name,
      tags,
      trace: false,
      func: (state, config) => this.run(state as any, config as RunnableConfig),
    });
    this.tools = tools;
    this.handleToolErrors = handleToolErrors ?? this.handleToolErrors;
    this.signal = options?.signal;
  }

  protected async runTool(
    call: ToolCall,
    config: RunnableConfig
  ): Promise<ToolMessage | Command> {
    const tool = this.tools.find((tool) => tool.name === call.name);
    try {
      if (tool === undefined) {
        throw new Error(`Tool "${call.name}" not found.`);
      }

      const output = await tool.invoke(
        { ...call, type: "tool_call" },
        {
          ...config,
          signal: mergeAbortSignals(this.signal, config.signal),
        }
      );

      if (ToolMessage.isInstance(output) || isCommand(output)) {
        if (ToolMessage.isInstance(output) && !output.status) {
          output.status = "success";
        }
        return output as ToolMessage | Command;
      }

      return new ToolMessage({
        name: tool.name,
        content: typeof output === "string" ? output : JSON.stringify(output),
        tool_call_id: call.id!,
        status: "success",
      });
    } catch (e: unknown) {
      /**
       * If tool invocation fails due to input parsing error, throw a {@link ToolInvocationError}
       */
      if (e instanceof ToolInputParsingException) {
        throw new ToolInvocationError(e as Error, call);
      }

      /**
       * throw the error if user prefers not to handle tool errors
       */
      if (!this.handleToolErrors) {
        throw e;
      }

      if (isGraphInterrupt(e)) {
        /**
         * {@link NodeInterrupt} errors are a breakpoint to bring a human into the loop.
         * As such, they are not recoverable by the agent and shouldn't be fed
         * back. Instead, re-throw these errors even when `handleToolErrors = true`.
         */
        throw e;
      }

      /**
       * If the signal is aborted, we want to bubble up the error to the invoke caller.
       */
      if (this.signal?.aborted) {
        throw e;
      }

      /**
       * if the user provides a function, call it with the error and tool call
       * and return the result if it is a {@link ToolMessage}
       */
      if (typeof this.handleToolErrors === "function") {
        const result = this.handleToolErrors(e, call);
        if (result && ToolMessage.isInstance(result)) {
          return result;
        }
      } else if (this.handleToolErrors) {
        return new ToolMessage({
          name: call.name,
          content: `${e}\n Please fix your mistakes.`,
          tool_call_id: call.id!,
          status: "error",
        });
      }

      /**
       * If the user doesn't handle the error, throw it
       */
      throw e;
    }
  }

  protected async run(
    state: any,
    config: RunnableConfig
  ): Promise<ContextSchema> {
    let outputs: (ToolMessage | Command)[];

    if (isSendInput(state)) {
      outputs = [await this.runTool(state.lg_tool_call, config)];
    } else {
      let messages: BaseMessage[];
      if (isBaseMessageArray(state)) {
        messages = state;
      } else if (isMessagesState(state)) {
        messages = state.messages;
      } else {
        throw new Error(
          "ToolNode only accepts BaseMessage[] or { messages: BaseMessage[] } as input."
        );
      }

      const toolMessageIds: Set<string> = new Set(
        messages
          .filter((msg) => msg.getType() === "tool")
          .map((msg) => (msg as ToolMessage).tool_call_id)
      );

      let aiMessage: AIMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (AIMessage.isInstance(message)) {
          aiMessage = message;
          break;
        }
      }

      if (!AIMessage.isInstance(aiMessage)) {
        throw new Error("ToolNode only accepts AIMessages as input.");
      }

      outputs = await Promise.all(
        aiMessage.tool_calls
          ?.filter((call) => call.id == null || !toolMessageIds.has(call.id))
          .map((call) => this.runTool(call, config)) ?? []
      );
    }

    // Preserve existing behavior for non-command tool outputs for backwards compatibility
    if (!outputs.some(isCommand)) {
      return (Array.isArray(state)
        ? outputs
        : { messages: outputs }) as unknown as ContextSchema;
    }

    // Handle mixed Command and non-Command outputs
    const combinedOutputs: (
      | { messages: BaseMessage[] }
      | BaseMessage[]
      | Command
    )[] = [];
    let parentCommand: Command | null = null;

    for (const output of outputs) {
      if (isCommand(output)) {
        if (
          output.graph === Command.PARENT &&
          Array.isArray(output.goto) &&
          output.goto.every((send) => _isSend(send))
        ) {
          if (parentCommand) {
            (parentCommand.goto as Send[]).push(...(output.goto as Send[]));
          } else {
            parentCommand = new Command({
              graph: Command.PARENT,
              goto: output.goto,
            });
          }
        } else {
          combinedOutputs.push(output);
        }
      } else {
        combinedOutputs.push(
          Array.isArray(state) ? [output] : { messages: [output] }
        );
      }
    }

    if (parentCommand) {
      combinedOutputs.push(parentCommand);
    }

    return combinedOutputs as unknown as ContextSchema;
  }
}

/**
 * @deprecated Use new `ToolNode` from {@link https://www.npmjs.com/package/langchain langchain} package instead.
 */
export function toolsCondition(
  state: BaseMessage[] | typeof MessagesAnnotation.State
): "tools" | typeof END {
  const message = Array.isArray(state)
    ? state[state.length - 1]
    : state.messages[state.messages.length - 1];

  if (
    message !== undefined &&
    "tool_calls" in message &&
    ((message as AIMessage).tool_calls?.length ?? 0) > 0
  ) {
    return "tools";
  } else {
    return END;
  }
}
