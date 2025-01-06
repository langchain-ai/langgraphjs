import { BaseMessage, ToolMessage } from "@langchain/core/messages";
import {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
  SharedValue,
  LangGraphRunnableConfig,
  interrupt,
} from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";

const GraphAnnotationOutput = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sharedStateValue: Annotation<string | null>(),
  interrupt: Annotation<boolean>(),
  keyOne: Annotation<string | null>(),
  keyTwo: Annotation<string | null>(),
});

const GraphAnnotationInput = Annotation.Root({
  ...GraphAnnotationOutput.spec,
  sharedState: SharedValue.on("user_id"),
  sharedStateFromStoreConfig: Annotation<Record<string, any> | null>,
});

// For shared state
const namespace = ["sharedState", "data"];
const key = "user_id";

const modelMap: Record<string, FakeListChatModel> = {};
const getModel = (threadId: string) => {
  modelMap[threadId] ??= new FakeListChatModel({ responses: ["begin", "end"] });
  return modelMap[threadId];
};

const agentNode = async (
  state: typeof GraphAnnotationInput.State,
  config: LangGraphRunnableConfig
) => {
  if (state.interrupt) interrupt("i want to interrupt");

  const model = getModel(config.configurable?.thread_id ?? "$");
  const response = await model.invoke(state.messages);
  const sharedStateValue = state.sharedState?.data?.user_id ?? null;

  // Define in the first node
  // Then retrieve in the second node
  const store = config.store;
  // Only set if it's not already set
  if (store && !state.sharedStateFromStoreConfig) {
    const value = { id: config?.configurable?.user_id };
    await store.put(namespace, key, value);
  }

  return {
    interrupt: false,
    messages: [response],
    sharedState: { data: { user_id: config?.configurable?.user_id } },
    sharedStateValue,
  };
};

const toolNode = async (
  state: typeof GraphAnnotationInput.State,
  config: LangGraphRunnableConfig
) => {
  const store = config.store;
  let sharedStateFromStoreConfig: Record<string, any> | null = null;
  if (store) {
    const result = await store.get(namespace, key);
    sharedStateFromStoreConfig = result?.value ?? null;
  }

  const lastMessage = state.messages.at(-1);
  if (!lastMessage) return { messages: [], sharedStateFromStoreConfig };
  return {
    messages: [
      new ToolMessage({
        content: `tool_call__${lastMessage.content as string}`,
        tool_call_id: "tool_call_id",
      }),
    ],
    sharedStateFromStoreConfig,
  };
};

const checkSharedStateNode = async (
  _: typeof GraphAnnotationInput.State,
  config: LangGraphRunnableConfig
): Promise<Partial<typeof GraphAnnotationInput.State>> => {
  const store = config.store;
  const namespace = ["inputtedState", "data"];
  const key = "my_key";
  if (store) {
    const result = await store.get(namespace, key);
    if (!result || !result.value.isTrue) {
      throw new Error("Value is not true");
    }
  }

  return {};
};

const agentCondEdge = (state: typeof GraphAnnotationInput.State) => {
  if ((state.messages[0].content as string) === "should_end") return END;
  if ((state.messages[0].content as string) === "___check_state_value")
    return "checkSharedState";

  const lastMessage = state.messages.at(-1);
  if (lastMessage?.content === "end") return END;
  return "tool";
};

const workflow = new StateGraph(
  {
    input: GraphAnnotationInput,
    output: GraphAnnotationOutput,
  },
  Annotation.Root({ model_name: Annotation<string> })
)
  .addNode("agent", agentNode)
  .addNode("tool", toolNode)
  .addNode("checkSharedState", checkSharedStateNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", agentCondEdge)
  .addEdge("tool", "agent")
  .addEdge("checkSharedState", END);

export const graph = (async () => workflow.compile())();
