import {
  Annotation,
  Command,
  END,
  interrupt,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";

const StateSchema = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (a: string[], b: string | string[]) => [
      ...a,
      ...(Array.isArray(b) ? b : [b]),
    ],
    default: () => [],
  }),
});

export const graph = new StateGraph(StateSchema)
  .addNode("router", () => new Command({ goto: END }), {
    ends: ["before_interrupt", "map", END],
  })
  .addNode("before_interrupt", () => ({ messages: ["before_interrupt"] }))
  .addNode("interrupt", () => {
    const resolved = interrupt("interrupt");
    return { messages: [`interrupt: ${resolved}`] };
  })
  .addNode(
    "map",
    () =>
      new Command({
        update: { messages: ["map"] },
        goto: [
          new Send("task", { value: 1 }),
          new Send("task", { value: 2 }),
          new Send("task", { value: 3 }),
        ],
      }),
    { ends: ["task"] }
  )
  .addNode("task", (arg: { value: number }) => ({
    messages: [`task: ${arg.value}`],
  }))
  .addEdge(START, "router")
  .addEdge("before_interrupt", "interrupt")
  .compile();
