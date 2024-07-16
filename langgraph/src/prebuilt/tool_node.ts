import {
  BaseMessage,
  ToolMessage,
  AIMessage,
  isBaseMessage,
} from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { StructuredTool } from "@langchain/core/tools";
import { RunnableCallable } from "../utils.js";
import { END } from "../graph/graph.js";
import { MessagesState } from "../graph/message.js";

export class ToolNode<
  T extends BaseMessage[] | MessagesState
> extends RunnableCallable<T, T> {
  /**
  A node that runs the tools requested in the last AIMessage. It can be used
  either in StateGraph with a "messages" key or in MessageGraph. If multiple
  tool calls are requested, they will be run in parallel. The output will be
  a list of ToolMessages, one for each tool call.
  */

  tools: StructuredTool[];

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
      }) ?? []
    );

    return Array.isArray(input) ? outputs : { messages: outputs };
  }
}

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
