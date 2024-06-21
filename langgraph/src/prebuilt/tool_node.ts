import { BaseMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { StructuredTool } from "@langchain/core/tools";
import { RunnableCallable } from "../utils.js";
import { END } from "../graph/graph.js";
import { MessagesState } from "../graph/message.js";

/**
 * ToolNode executes the provided functions when requested by an LLM as tool_calls.
 *
 * Key expectations:
 * 1. Input: Expects either a BaseMessage[] or an object with a messages key containing a list of BaseMessages.
 *        The last message **must** be an AIMessage containing `tool_call`'s.
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
 * const tools = [new TavilySearchResults({ maxResults: 1 })];
 * const toolNode = new ToolNode(tools);
 *
 * const workflow = new StateGraph({ channels: graphState })
 *   .addNode("agent", callModel) // contains an LLM that will emit an AIMessage with tool_calls
 *   .addNode("tools", toolNode)
 *   .addConditionalEdges("agent", toolsCondition)
 *   .addEdge("tools", "agent"); // After tools are executed, return to the agent to summarize results.
 * ```
 */
export class ToolNode<
  T extends BaseMessage[] | MessagesState
> extends RunnableCallable<T, T> {
  /** The array of tools available for execution. */
  tools: StructuredTool[];

  /**
   * Creates a new ToolNode instance.
   *
   * @param tools - An array of `StructuredTool` objects available for execution.
   * @param name - The name of the node. Defaults to "tools".
   * @param tags - An array of tags for the node. Defaults to an empty array.
   *
   * @example
   * ```typescript
   * import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
   *
   * const tools = [new TavilySearchResults({ maxResults: 1 })];
   * const toolNode = new ToolNode(tools, "search_tools", ["search"]);
   * ```
   */
  constructor(
    tools: StructuredTool[],
    name: string = "tools",
    tags: string[] = []
  ) {
    super({ name, tags, func: (input, config) => this.run(input, config) });
    this.tools = tools;
  }

  private async run(
    input: BaseMessage[] | MessagesState,
    config: RunnableConfig
  ): Promise<BaseMessage[] | MessagesState> {
    const message = Array.isArray(input)
      ? input[input.length - 1]
      : input.messages[input.messages.length - 1];

    if (message._getType() !== "ai") {
      throw new Error("ToolNode only accepts AIMessages as input.");
    }

    const outputs = await Promise.all(
      (message as AIMessage).tool_calls?.map(async (call) => {
        const tool = this.tools.find((tool) => tool.name === call.name);
        if (tool === undefined) {
          throw new Error(`Tool ${call.name} not found.`);
        }
        const output = await tool.invoke(call.args, config);
        return new ToolMessage({
          name: tool.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: call.id!,
        });
      }) ?? []
    );

    return Array.isArray(input) ? outputs : { messages: outputs };
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
  state: BaseMessage[] | MessagesState
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
