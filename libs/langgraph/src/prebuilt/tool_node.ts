import {
  BaseMessage,
  ToolMessage,
  AIMessage,
  isBaseMessage,
} from "@langchain/core/messages";
import { RunnableConfig, RunnableToolLike } from "@langchain/core/runnables";
import { StructuredToolInterface } from "@langchain/core/tools";
import { RunnableCallable } from "../utils.js";
import { END } from "../graph/graph.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

export type ToolNodeOptions = {
  name?: string;
  tags?: string[];
  handleToolErrors?: boolean;
};

/**
 * ToolNode executes the provided functions when requested by an LLM as tool_calls.
 *
 * Key expectations:
 * 1. Input: Expects either a BaseMessage[] or an object with a messages key containing a list of BaseMessages.
 *     The last message **must** be an AIMessage containing `tool_call`'s.
 * 2. Tool Execution: Processes all tool calls found in the last AIMessage, executing them in parallel.
 * 3. Output: Returns either an array of `ToolMessage`'s or an object with a messages key containing the `ToolMessage`'s, depending on the input type.
 * 4. Error Handling: Throws errors for invalid inputs (non-AIMessage) or if a requested tool is not found.
 *
 * Typical usage:
 * - Construct the ToolNode with the same list of tools (functions) provided to the LLM for tool calling.
 * - Ensure the AI model is aware of and can request the tools available to the ToolNode (e.g., by calling .llm.bind_tools(tools))
 * - Route to the tool node only if the last message contains tool calls.
 *
 * @typeparam T - The type of input, either an array of `BaseMessage` or `MessagesState`.
 *
 * @example
 * ```typescript
 * import { MessagesAnnotation } from "@langchain/langgraph";
 * 
 * const tools = [new TavilySearchResults({ maxResults: 1 })];
 * const toolNode = new ToolNode(tools);
 *
 * const workflow = new StateGraph(MessagesAnnotation)
 *   .addNode("agent", callModel) // contains an LLM that will emit an AIMessage with tool_calls
 *   .addNode("tools", toolNode)
 *   .addConditionalEdges("agent", toolsCondition)
 *   .addEdge("tools", "agent"); // After tools are executed, return to the agent to summarize results.
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ToolNode<T = any> extends RunnableCallable<T, T> {
  /** The array of tools available for execution. */
  tools: (StructuredToolInterface | RunnableToolLike)[];

  handleToolErrors = true;

  constructor(
    tools: (StructuredToolInterface | RunnableToolLike)[],
    options?: ToolNodeOptions
  ) {
    const { name, tags, handleToolErrors } = options ?? {};
    super({ name, tags, func: (input, config) => this.run(input, config) });
    this.tools = tools;
    this.handleToolErrors = handleToolErrors ?? this.handleToolErrors;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async run(input: any, config: RunnableConfig): Promise<T> {
    const message = Array.isArray(input)
      ? input[input.length - 1]
      : input.messages[input.messages.length - 1];

    if (message?._getType() !== "ai") {
      throw new Error("ToolNode only accepts AIMessages as input.");
    }

    const outputs = await Promise.all(
      (message as AIMessage).tool_calls?.map(async (call) => {
        const tool = this.tools.find((tool) => tool.name === call.name);
        try {
          if (tool === undefined) {
            throw new Error(`Tool "${call.name}" not found.`);
          }
          const output = await tool.invoke(
            { ...call, type: "tool_call" },
            config
          );
          if (isBaseMessage(output) && output._getType() === "tool") {
            return output;
          } else {
            return new ToolMessage({
              name: tool.name,
              content:
                typeof output === "string" ? output : JSON.stringify(output),
              tool_call_id: call.id!,
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (!this.handleToolErrors) {
            throw e;
          }
          return new ToolMessage({
            content: `Error: ${e.message}\n Please fix your mistakes.`,
            name: call.name,
            tool_call_id: call.id ?? "",
          });
        }
      }) ?? []
    );

    return (Array.isArray(input) ? outputs : { messages: outputs }) as T;
  }
}

/**
 * Determines whether to route to the `tools` node or to end the graph execution.
 * This function is typically used in conjunction with ToolNode to control the flow in a graph.
 *
 * @param state - Either an array of BaseMessage or a MessagesState object.
 * @returns "tools" if there are tool calls in the last message, otherwise returns END.
 *
 * @example
 * ```typescript
 * const state = [new AIMessage({
 *   content: "We need to search for information.",
 *   tool_calls: [{ name: "search", args: { query: "LangChain usage" }, id: "tc_1" }]
 * })];
 * const result = toolsCondition(state);
 * console.log(result); // "tools"
 * ```
 */
export function toolsCondition(
  state: BaseMessage[] | typeof MessagesAnnotation.State
): "tools" | typeof END {
  const message = Array.isArray(state)
    ? state[state.length - 1]
    : state.messages[state.messages.length - 1];

  if (
    "tool_calls" in message &&
    ((message as AIMessage).tool_calls?.length ?? 0) > 0
  ) {
    return "tools";
  } else {
    return END;
  }
}
