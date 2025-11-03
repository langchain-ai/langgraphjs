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
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type { InteropZodToStateDefinition } from "../graph/zod/meta.js";

// Define types for annotation compatibility
export type AnyAnnotationRoot = AnnotationRoot<any>;

type ToAnnotationRoot<A extends AnyAnnotationRoot | InteropZodObject> =
  A extends AnyAnnotationRoot
    ? A
    : A extends InteropZodObject
    ? AnnotationRoot<InteropZodToStateDefinition<A>>
    : never;

/**
 * Runtime context for tool execution.
 */
export interface ToolCallRuntime {
  context?: LangGraphRunnableConfig["context"];
  writer?: LangGraphRunnableConfig["writer"];
  interrupt?: LangGraphRunnableConfig["interrupt"];
  signal?: AbortSignal;
}

/**
 * Request object passed to tool call middleware.
 */
export interface ToolCallRequest {
  toolCall: ToolCall;
  tool: StructuredToolInterface | DynamicTool | RunnableToolLike;
  state: any;
  runtime: ToolCallRuntime;
}

/**
 * Hook function for wrapping tool execution.
 * Allows middleware to intercept and modify tool calls before execution.
 */
export type WrapToolCallHook = (
  request: ToolCallRequest,
  handler: (request: ToolCallRequest) => Promise<ToolMessage | Command>
) => Promise<ToolMessage | Command>;

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
   * **Default behavior** (matches Python):
   *   - Catches only `ToolInvocationError` (invalid arguments from model) and converts to ToolMessage
   *   - Re-raises all other errors including errors from `wrapToolCall` middleware
   *
   * If `true`:
   *   - Catches all errors and returns a ToolMessage with the error
   *
   * If `false`:
   *   - All errors are thrown immediately
   *
   * If a function is provided:
   *   - If function returns a `ToolMessage`, use it as the result
   *   - If function returns `undefined`, re-raise the error
   *
   * @default A function that only catches ToolInvocationError
   */
  handleToolErrors?:
    | boolean
    | ((error: unknown, toolCall: ToolCall) => ToolMessage | undefined);
  /**
   * Optional wrapper function for tool execution.
   * Allows middleware to intercept and modify tool calls before execution.
   * The wrapper receives the tool call request and a handler function to execute the tool.
   */
  wrapToolCall?: WrapToolCallHook;
}

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

/**
 * Default error handler for tool errors.
 *
 * This is applied to errors from baseHandler (tool execution).
 * For errors from wrapToolCall middleware, those are handled separately
 * and will bubble up by default.
 *
 * Catches all tool execution errors and converts them to ToolMessage.
 * This allows the LLM to see the error and potentially retry with different arguments.
 */
function defaultHandleToolErrors(
  error: unknown,
  toolCall: ToolCall
): ToolMessage | undefined {
  if (error instanceof ToolInvocationError) {
    return new ToolMessage({
      content: error.message,
      tool_call_id: toolCall.id!,
      name: toolCall.name,
    });
  }

  /**
   * Catch all other tool errors and convert to ToolMessage
   */
  return new ToolMessage({
    content: `${error}\n Please fix your mistakes.`,
    tool_call_id: toolCall.id!,
    name: toolCall.name,
  });
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
    | ((error: unknown, toolCall: ToolCall) => ToolMessage | undefined) =
    defaultHandleToolErrors;

  wrapToolCall?: WrapToolCallHook;

  constructor(
    tools: (StructuredToolInterface | DynamicTool | RunnableToolLike)[],
    public options?: ToolNodeOptions
  ) {
    const { name, tags, handleToolErrors, signal, wrapToolCall } =
      options ?? {};
    super({
      name,
      tags,
      trace: false,
      func: (state, config) =>
        this.run(
          state as ToAnnotationRoot<StateSchema>["State"],
          config as RunnableConfig
        ),
    });
    this.tools = tools;
    this.handleToolErrors = handleToolErrors ?? this.handleToolErrors;
    this.signal = signal;
    this.wrapToolCall = wrapToolCall;
  }

  /**
   * Handle errors from tool execution or middleware.
   * @param error - The error to handle
   * @param call - The tool call that caused the error
   * @param isMiddlewareError - Whether the error came from wrapToolCall middleware
   * @returns ToolMessage if error is handled, otherwise re-throws
   */
  #handleError(
    error: unknown,
    call: ToolCall,
    isMiddlewareError: boolean
  ): ToolMessage {
    /**
     * {@link NodeInterrupt} errors are a breakpoint to bring a human into the loop.
     * As such, they are not recoverable by the agent and shouldn't be fed
     * back. Instead, re-throw these errors even when `handleToolErrors = true`.
     */
    if (isGraphInterrupt(error)) {
      throw error;
    }

    /**
     * If the signal is aborted, we want to bubble up the error to the invoke caller.
     */
    if (this.signal?.aborted) {
      throw error;
    }

    /**
     * If error is from middleware and handleToolErrors is not true, bubble up
     * (default handler and false both re-raise middleware errors)
     */
    if (isMiddlewareError && this.handleToolErrors !== true) {
      throw error;
    }

    /**
     * If handleToolErrors is false, throw all errors
     */
    if (!this.handleToolErrors) {
      throw error;
    }

    /**
     * Apply handleToolErrors to the error
     */
    if (typeof this.handleToolErrors === "function") {
      const result = this.handleToolErrors(error, call);
      if (result && ToolMessage.isInstance(result)) {
        return result;
      }

      /**
       * `handleToolErrors` returned undefined - re-raise
       */
      throw error;
    } else if (this.handleToolErrors) {
      return new ToolMessage({
        name: call.name,
        content: `${error}\n Please fix your mistakes.`,
        tool_call_id: call.id!,
      });
    }

    /**
     * Shouldn't reach here, but throw as fallback
     */
    throw error;
  }

  protected async runTool(
    call: ToolCall,
    config: RunnableConfig,
    state: any
  ): Promise<ToolMessage | Command> {
    /**
     * Define the base handler that executes the tool.
     * When wrapToolCall middleware is present, this handler does NOT catch errors
     * so the middleware can handle them.
     * When no middleware, errors are caught and handled here.
     */
    const baseHandler = async (
      request: ToolCallRequest
    ): Promise<ToolMessage | Command> => {
      const { toolCall } = request;

      const tool = this.tools.find((tool) => tool.name === toolCall.name);
      if (tool === undefined) {
        throw new Error(`Tool "${toolCall.name}" not found.`);
      }

      try {
        const output = await tool.invoke(
          { ...toolCall, type: "tool_call" },
          {
            ...config,
            signal: mergeAbortSignals(this.signal, config.signal),
          }
        );

        if (ToolMessage.isInstance(output) || isCommand(output)) {
          return output as ToolMessage | Command;
        }

        return new ToolMessage({
          name: tool.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: toolCall.id!,
        });
      } catch (e: unknown) {
        /**
         * Handle errors from tool execution (not from wrapToolCall)
         * If tool invocation fails due to input parsing error, throw a {@link ToolInvocationError}
         */
        if (e instanceof ToolInputParsingException) {
          throw new ToolInvocationError(e, toolCall);
        }

        /**
         * Re-throw to be handled by caller
         */
        throw e;
      }
    };

    /**
     * Build runtime from LangGraph config
     */
    const lgConfig = config as LangGraphRunnableConfig;
    const runtime: ToolCallRuntime = {
      context: lgConfig?.context,
      writer: lgConfig?.writer,
      interrupt: lgConfig?.interrupt,
      signal: lgConfig?.signal,
    };

    /**
     * Find the tool instance to include in the request
     */
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      throw new Error(`Tool "${call.name}" not found.`);
    }

    const request: ToolCallRequest = {
      toolCall: call,
      tool,
      state,
      runtime,
    };

    /**
     * If wrapToolCall is provided, use it to wrap the tool execution
     */
    if (this.wrapToolCall) {
      try {
        return await this.wrapToolCall(request, baseHandler);
      } catch (e: unknown) {
        /**
         * Handle middleware errors
         */
        return this.#handleError(e, call, true);
      }
    }

    /**
     * No wrapToolCall - execute tool directly and handle errors here
     */
    try {
      return await baseHandler(request);
    } catch (e: unknown) {
      /**
       * Handle tool errors when no middleware provided
       */
      return this.#handleError(e, call, false);
    }
  }

  protected async run(
    state: ToAnnotationRoot<StateSchema>["State"],
    config: RunnableConfig
  ): Promise<ContextSchema> {
    let outputs: (ToolMessage | Command)[];

    if (isSendInput(state)) {
      const { lg_tool_call, ...newState } = state;
      outputs = [await this.runTool(lg_tool_call, config, newState)];
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
          .map((call) => this.runTool(call, config, state)) ?? []
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
