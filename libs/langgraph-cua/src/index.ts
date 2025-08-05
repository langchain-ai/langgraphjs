import {
  Annotation,
  AnnotationRoot,
  END,
  LangGraphRunnableConfig,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { SystemMessage } from "@langchain/core/messages";
import { callModel } from "./nodes/call-model.js";
import { createVMInstance } from "./nodes/create-vm-instance.js";
import { takeComputerAction } from "./nodes/take-computer-action.js";
import {
  CUAState,
  CUAAnnotation,
  CUAConfigurable,
  CUAUpdate,
} from "./types.js";
import { getToolOutputs, isComputerCallToolMessage } from "./utils.js";

/**
 * Routes to the nodeBeforeAction node if a computer call is present
 * in the last message, otherwise routes to END.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"nodeBeforeAction" | typeof END | "createVMInstance"} The next node to execute.
 */
function takeActionOrEnd(
  state: CUAState
): "nodeBeforeAction" | "createVMInstance" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolOutputs = getToolOutputs(lastMessage);
  if (!lastMessage || !toolOutputs?.length) {
    return END;
  }

  if (!state.instanceId) {
    return "createVMInstance";
  }

  return "nodeBeforeAction";
}

/**
 * Routes to the callModel node if a computer call output is present,
 * otherwise routes to END.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"callModel" | typeof END} The next node to execute.
 */
function reinvokeModelOrEnd(state: CUAState): "callModel" | typeof END {
  const lastMsg = state.messages[state.messages.length - 1];
  if (isComputerCallToolMessage(lastMsg)) {
    return "callModel";
  }
  return END;
}

/**
 * Configuration for the Computer Use Agent.
 */
interface CreateCuaParams<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StateModifier extends AnnotationRoot<any> = typeof CUAAnnotation
> {
  /**
   * The API key to use for Scrapybara.
   * This can be provided in the configuration, or set as an environment variable (SCRAPYBARA_API_KEY).
   * @default process.env.SCRAPYBARA_API_KEY
   */
  scrapybaraApiKey?: string;

  /**
   * The number of hours to keep the virtual machine running before it times out.
   * Must be between 0.01 and 24.
   * @default 1
   */
  timeoutHours?: number;

  /**
   * Whether or not Zero Data Retention is enabled in the user's OpenAI account. If true,
   * the agent will not pass the 'previous_response_id' to the model, and will always pass it the full
   * message history for each request. If false, the agent will pass the 'previous_response_id' to the
   * model, and only the latest message in the history will be passed.
   * @default false
   */
  zdrEnabled?: boolean;

  /**
   * The maximum number of recursive calls the agent can make.
   * @default 100
   */
  recursionLimit?: number;

  /**
   * The ID of the authentication state. If defined, it will be used to authenticate
   * with Scrapybara. Only applies if 'environment' is set to 'web'.
   * @default undefined
   */
  authStateId?: string;

  /**
   * The environment to use.
   * @default "web"
   */
  environment?: "web" | "ubuntu" | "windows";

  /**
   * The prompt to use for the model. This will be used as the system prompt for the model.
   * @default undefined
   */
  prompt?: string | SystemMessage;

  /**
   * A custom node to run before the computer action.
   * @default undefined
   */
  nodeBeforeAction?: (
    state: CUAState & StateModifier["State"],
    config: LangGraphRunnableConfig<typeof CUAConfigurable.State>
  ) => Promise<CUAUpdate & StateModifier["Update"]>;

  /**
   * A custom node to run after the computer action.
   * @default undefined
   */
  nodeAfterAction?: (
    state: CUAState & StateModifier["State"],
    config: LangGraphRunnableConfig<typeof CUAConfigurable.State>
  ) => Promise<CUAUpdate & StateModifier["Update"]>;

  /**
   * Optional state modifier for customizing the agent's state.
   * @default undefined
   */
  stateModifier?: StateModifier;
  /**
   * A custom function to handle uploading screenshots to an external
   * store, instead of saving them as base64 in state.
   * Must accept a base64 string and return a URL.
   * @default undefined
   */
  uploadScreenshot?: (screenshot: string) => Promise<string>;
}

/**
 * Creates and configures a Computer Use Agent.
 *
 * @returns The configured graph.
 */
export function createCua<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StateModifier extends AnnotationRoot<any> = typeof CUAAnnotation
>({
  scrapybaraApiKey,
  timeoutHours = 1.0,
  zdrEnabled = false,
  recursionLimit = 100,
  authStateId,
  environment = "web",
  prompt,
  nodeBeforeAction,
  nodeAfterAction,
  uploadScreenshot,
  stateModifier,
}: CreateCuaParams<StateModifier> = {}) {
  // Validate timeout_hours is within acceptable range
  if (timeoutHours < 0.01 || timeoutHours > 24) {
    throw new Error("timeoutHours must be between 0.01 and 24");
  }

  const nodeBefore = nodeBeforeAction ?? (async () => {});
  const nodeAfter = nodeAfterAction ?? (async () => {});

  const StateAnnotation = Annotation.Root({
    ...CUAAnnotation.spec,
    ...stateModifier?.spec,
  });

  const workflow = new StateGraph(StateAnnotation, CUAConfigurable)
    .addNode("callModel", callModel)
    .addNode("createVMInstance", createVMInstance)
    .addNode("nodeBeforeAction", nodeBefore)
    .addNode("nodeAfterAction", nodeAfter)
    .addNode("takeComputerAction", (state, config) =>
      takeComputerAction(state, config, { uploadScreenshot })
    )
    .addEdge(START, "callModel")
    .addConditionalEdges("callModel", takeActionOrEnd, [
      "createVMInstance",
      "nodeBeforeAction",
      END,
    ])
    .addEdge("nodeBeforeAction", "takeComputerAction")
    .addEdge("takeComputerAction", "nodeAfterAction")
    .addEdge("createVMInstance", "nodeBeforeAction")
    .addConditionalEdges("nodeAfterAction", reinvokeModelOrEnd, [
      "callModel",
      END,
    ]);

  const cuaGraph = workflow.compile();
  cuaGraph.name = "Computer Use Agent";

  // Configure the graph with the provided parameters
  const configuredGraph = cuaGraph.withConfig({
    configurable: {
      scrapybaraApiKey,
      timeoutHours,
      zdrEnabled,
      authStateId,
      environment,
      prompt,
    },
    recursionLimit,
  });

  return configuredGraph;
}

export {
  type CUAState,
  type CUAUpdate,
  CUAAnnotation,
  CUAConfigurable,
  type CUAEnvironment,
} from "./types.js";
export { getToolOutputs, isComputerCallToolMessage } from "./utils.js";
