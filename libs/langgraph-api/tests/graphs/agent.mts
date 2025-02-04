import { BaseMessage, ToolMessage } from "@langchain/core/messages";
import {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
  SharedValue,
  interrupt,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { v4 as uuidv4 } from "uuid";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
const GraphAnnotationOutput = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sharedStateValue: Annotation<string | null>(),
  interrupt: Annotation<boolean>(),
  keyOne: Annotation<string | null>(),
  keyTwo: Annotation<string | null>(),
  sleep: Annotation<number | null>(),
});

const GraphAnnotationInput = Annotation.Root({
  ...GraphAnnotationOutput.spec,
  sharedState: SharedValue.on("user_id"),
  sharedStateFromStoreConfig: Annotation<Record<string, any> | null>,
});

class StableFakeListChatModel extends FakeListChatModel {
  streamMessageId: string = uuidv4();

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const response = this._currentResponse();
    this._incrementResponse();
    this.streamMessageId = uuidv4();

    if (this.emitCustomEvent) {
      await runManager?.handleCustomEvent("some_test_event", {
        someval: true,
      });
    }

    for await (const text of response) {
      await this._sleepIfRequested();
      if (options?.thrownErrorString) {
        throw new Error(options.thrownErrorString);
      }
      const chunk = this._createResponseChunk(text);

      // ensure stable ID
      chunk.message.id = this.streamMessageId;
      chunk.message.lc_kwargs.id = this.streamMessageId;

      yield chunk;

      void runManager?.handleLLMNewToken(
        text,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk }
      );
    }
  }
}

// For shared state
const namespace = ["sharedState", "data"];
const key = "user_id";

const modelMap: Record<string, FakeListChatModel> = {};
const getModel = (threadId: string) => {
  modelMap[threadId] ??= new StableFakeListChatModel({
    responses: ["begin", "end"],
  });
  return modelMap[threadId];
};

const agentNode = async (
  state: typeof GraphAnnotationInput.State,
  config: LangGraphRunnableConfig
) => {
  if (state.interrupt) interrupt("i want to interrupt");

  if (state.sleep != null && state.messages.at(-1)?.getType() === "human") {
    const sleep = state.sleep;
    await new Promise((resolve) => setTimeout(resolve, sleep * 1000));
  }

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
