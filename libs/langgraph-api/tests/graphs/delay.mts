import {
  MessagesAnnotation,
  StateGraph,
  END,
  START,
  Annotation,
} from "@langchain/langgraph";

const StateSchema = Annotation.Root({
  ...MessagesAnnotation.spec,
  delay: Annotation<number>(),
});

const longRunning = async (
  state: typeof StateSchema.State,
): Promise<typeof StateSchema.Update> => {
  await new Promise((resolve) => setTimeout(resolve, state.delay));
  return { messages: [`finished after ${state.delay}ms`] };
};

export const graph = new StateGraph(StateSchema)
  .addNode("long_running", longRunning)
  .addEdge(START, "long_running")
  .addEdge("long_running", END)
  .compile();
