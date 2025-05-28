import {
  StateGraph,
  END,
  Send,
  MessagesAnnotation,
  Annotation,
  START,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";

const getStableModel = (() => {
  const cached: Record<string, FakeListChatModel> = {};
  return (threadId: string) => {
    cached[threadId] ??= new FakeListChatModel({
      responses: ["begin", "end\u2028"],
    });
    return cached[threadId];
  };
})();

const AgentState = Annotation.Root({
  key_one: Annotation<string>(),
  key_two: Annotation<string>(),
  sleep: Annotation<number>(),
  messages: MessagesAnnotation.spec.messages,
});

async function callModel(
  state: typeof AgentState.State,
  config: LangGraphRunnableConfig,
): Promise<typeof AgentState.Update> {
  let userId: string | undefined;

  if (config.configurable?.langgraph_auth_user != null) {
    const user = config.configurable?.langgraph_auth_user as
      | { identity: string }
      | undefined;

    userId = user?.identity;
  }

  if (config.configurable?.["x-configurable-header"] != null) {
    return {
      messages: [`end: ${config.configurable?.["x-configurable-header"]}`],
    };
  }

  const model = getStableModel(config.configurable?.thread_id ?? "$");
  const existing = await config.store?.get([userId ?? "ALL"], "key_one");
  if (!existing) {
    const text = state.messages.at(-1)?.content;
    await config.store?.put([userId ?? "ALL"], "key_one", { text });
  }

  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

async function callTool(
  message: BaseMessage,
): Promise<typeof AgentState.Update> {
  const response = new ToolMessage(
    `tool_call__${message.content}`,
    "tool_call_id",
  );
  return { messages: [response] };
}

function shouldContinue(state: typeof AgentState.State): typeof END | Send {
  const lastMessage = state.messages.at(-1);
  if ((lastMessage?.content as string).startsWith("end")) return END;
  return new Send("tool", lastMessage);
}

const workflow = new StateGraph(AgentState)
  .addNode("agent", callModel)
  .addNode("tool", callTool)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tool", "agent");

export const graph = workflow.compile();
