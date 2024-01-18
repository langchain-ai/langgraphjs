import {
  RunnableBinding,
  RunnableConfig,
  RunnableLambda,
} from "@langchain/core/runnables";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const INVALID_TOOL_MSG_TEMPLATE = `{requestedToolName} is not a valid tool, try one of [availableToolNamesString].`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZodObjectAnyType = z.ZodObject<any, any, any, any>;

export interface ToolExecutorArgs<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ZodObjectAnyType = ZodObjectAnyType
> {
  tools: Array<StructuredTool<T>>;
  /**
   * @default {INVALID_TOOL_MSG_TEMPLATE}
   */
  invalidToolMsgTemplate?: string;
}

/**
 * Interface for invoking a tool
 */
export interface ToolInvocationInterface<T> {
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolInput: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecutorInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecutorOutputType = any;

export class ToolExecutor<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ZodObjectAnyType = ZodObjectAnyType
> extends RunnableBinding<ToolExecutorInputType, ToolExecutorOutputType> {
  lc_graph_name = "ToolExecutor";

  tools: Array<StructuredTool<T>>;

  toolMap: Record<string, StructuredTool<T>>;

  invalidToolMsgTemplate: string;

  constructor(fields: ToolExecutorArgs<T>) {
    const fieldsWithDefaults = {
      invalidToolMsgTemplate: INVALID_TOOL_MSG_TEMPLATE,
      ...fields,
    };
    const bound = new RunnableLambda({
      func: async (
        input: ToolInvocationInterface<T>,
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
    }, {} as Record<string, StructuredTool<T>>);
  }

  async _execute(
    toolInvocation: ToolInvocationInterface<T>,
    _config?: RunnableConfig
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
      const output = await tool.invoke(toolInvocation.toolInput);
      return output;
    }
  }
}
