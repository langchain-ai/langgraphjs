import {
  RunnableBinding,
  RunnableConfig,
  RunnableLambda,
  RunnableToolLike,
} from "@langchain/core/runnables";
import { StructuredToolInterface } from "@langchain/core/tools";

const INVALID_TOOL_MSG_TEMPLATE = `{requestedToolName} is not a valid tool, try one of {availableToolNamesString}.`;

/** @deprecated Use {@link ToolNode} instead. */
export interface ToolExecutorArgs {
  tools: Array<StructuredToolInterface | RunnableToolLike>;
  /**
   * @default {INVALID_TOOL_MSG_TEMPLATE}
   */
  invalidToolMsgTemplate?: string;
}

/**
 * Interface for invoking a tool
 */
export interface ToolInvocationInterface {
  tool: string;
  toolInput: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecutorInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecutorOutputType = any;

/** @deprecated Use {@link ToolNode} instead. */
export class ToolExecutor extends RunnableBinding<
  ToolExecutorInputType,
  ToolExecutorOutputType
> {
  lc_graph_name = "ToolExecutor";

  tools: Array<StructuredToolInterface | RunnableToolLike>;

  toolMap: Record<string, StructuredToolInterface | RunnableToolLike>;

  invalidToolMsgTemplate: string;

  constructor(fields: ToolExecutorArgs) {
    const fieldsWithDefaults = {
      invalidToolMsgTemplate: INVALID_TOOL_MSG_TEMPLATE,
      ...fields,
    };
    const bound = RunnableLambda.from(
      async (input: ToolInvocationInterface, config?: RunnableConfig) =>
        this._execute(input, config)
    );
    super({
      bound,
      config: {},
    });
    this.tools = fieldsWithDefaults.tools;
    this.invalidToolMsgTemplate = fieldsWithDefaults.invalidToolMsgTemplate;
    this.toolMap = this.tools.reduce((acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    }, {} as Record<string, StructuredToolInterface | RunnableToolLike>);
  }

  /**
   * Execute a tool invocation
   *
   * @param {ToolInvocationInterface} toolInvocation The tool to invoke and the input to pass to it.
   * @param {RunnableConfig | undefined} config Optional configuration to pass to the tool when invoked.
   * @returns Either the result of the tool invocation (`string` or `ToolMessage`, set by the `ToolOutput` generic) or a string error message.
   */
  async _execute(
    toolInvocation: ToolInvocationInterface,
    config?: RunnableConfig
  ): Promise<ToolExecutorOutputType> {
    if (!(toolInvocation.tool in this.toolMap)) {
      return this.invalidToolMsgTemplate
        .replace("{requestedToolName}", toolInvocation.tool)
        .replace(
          "{availableToolNamesString}",
          Object.keys(this.toolMap).join(", ")
        );
    } else {
      const tool = this.toolMap[toolInvocation.tool];
      const output = await tool.invoke(toolInvocation.toolInput, config);
      return output;
    }
  }
}
