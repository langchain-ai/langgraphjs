import {
  RunnableBinding,
  RunnableConfig,
  RunnableLambda,
} from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";

const INVALID_TOOL_MSG_TEMPLATE = `{requestedToolName} is not a valid tool, try one of [availableToolNamesString].`;

export interface ToolExecutorArgs {
  tools: Array<Tool>;
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

export class ToolExecutor extends RunnableBinding<
  ToolExecutorInputType,
  ToolExecutorOutputType
> {
  lc_graph_name = "ToolExecutor";

  tools: Array<Tool>;

  toolMap: Record<string, Tool>;

  invalidToolMsgTemplate: string;

  constructor(fields: ToolExecutorArgs) {
    const fieldsWithDefaults = {
      invalidToolMsgTemplate: INVALID_TOOL_MSG_TEMPLATE,
      ...fields,
    };
    const bound = new RunnableLambda({
      func: async (
        input: ToolInvocationInterface,
        options?: { config?: RunnableConfig }
      ) => this._execute(input, options?.config),
    });
    super({
      bound,
      config: {},
    });
    this.tools = fieldsWithDefaults.tools;
    this.invalidToolMsgTemplate = fieldsWithDefaults.invalidToolMsgTemplate;
    this.toolMap = this.tools.reduce((acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    }, {} as Record<string, Tool>);
  }

  async _execute(
    toolInvocation: ToolInvocationInterface,
    config?: RunnableConfig
  ): Promise<string> {
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
