import {
  BaseMessage,
  ToolMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { v4 as uuidv4 } from "uuid";
const model = new FakeListChatModel({ responses: ["begin", "end"] });

const isRemoveMessage = (x: BaseMessage): x is RemoveMessage =>
  x._getType() === "remove";

type Messages = BaseMessage | BaseMessage[];

function addMessages(left: Messages, right: Messages): BaseMessage[] {
  const leftList = Array.isArray(left) ? left : [left];
  const rightList = Array.isArray(right) ? right : [right];
  leftList.forEach((m) => !m.id && (m.id = uuidv4()));
  rightList.forEach((m) => !m.id && (m.id = uuidv4()));

  const leftIdxById = new Map(leftList.map((m, i) => [m.id, i]));

  const result = [...leftList];
  const toRemove = new Set<string>();

  for (const right of rightList) {
    const idx = leftIdxById.get(right.id);

    if (idx != null) {
      if (isRemoveMessage(right)) {
        if (right.id) toRemove.add(right.id);
      } else {
        result[idx] = right;
      }
    } else {
      if (isRemoveMessage(right)) {
        throw new Error(
          `Attempting to delete a message with an ID that doesn't exist ('${right.id}')`
        );
      }
      result.push(right);
    }
  }

  return result.filter((m) => !toRemove.has(m.id!));
}

const addMessage = {
  // TODO: we should infer the type of the write?
  reducer: addMessages,
  // TODO: why we wouldn't support just providing the value
  default: () => [],
};

const workflow = new StateGraph({
  messages: Annotation<BaseMessage[]>(addMessage),
})
  .addNode("agent", async (state) => {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  })
  .addNode("tool", async () => ({
    messages: [
      new ToolMessage({
        content: "Hello from tool",
        tool_call_id: "tool_call_id",
      }),
    ],
  }))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", (state) => {
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.content === "end") return END;
    return "tool";
  })
  .addEdge("tool", "agent");

export const graph = workflow.compile();
