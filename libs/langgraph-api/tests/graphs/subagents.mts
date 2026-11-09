// The deep-agent shape: a root node hands two tool calls to `tools`, and each
// runs a subgraph. Tool calls come as `lg_tool_call`, like langchainjs `createAgent`.
// The `flaky` topic fails its first attempt in each thread, and `tools` retries it.
import {
  Annotation,
  END,
  START,
  Send,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

const SubagentState = Annotation.Root({
  topic: Annotation<string>,
  answer: Annotation<string>,
  askApproval: Annotation<boolean>,
});

const failedOnce = new Set<string>();

const subagent = new StateGraph(SubagentState)
  .addNode("research", (state, config) => {
    if (state.askApproval) interrupt(`research ${state.topic}?`);
    if (state.topic === "fail")
      throw new Error("connect to db://admin:hunter2");
    const thread = String(config.configurable?.thread_id);
    if (state.topic === "flaky" && !failedOnce.has(thread)) {
      failedOnce.add(thread);
      throw new Error("try again");
    }
    return { answer: `notes on ${state.topic}` };
  })
  .addEdge(START, "research")
  .addEdge("research", END)
  .compile();

const State = Annotation.Root({
  results: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  topics: Annotation<string[]>,
  askApproval: Annotation<boolean>,
});

type Task = {
  lg_tool_call: { id: string; name: string; args: Record<string, unknown> };
  topic: string;
  askApproval: boolean;
};

export const graph = new StateGraph(State)
  .addNode("plan", () => ({ results: ["plan"] }))
  .addNode(
    "tools",
    async (task: Task) => {
      const result = await subagent.invoke({
        topic: task.topic,
        answer: "",
        askApproval: task.askApproval,
      });
      return { results: [result.answer] };
    },
    {
      retryPolicy: {
        maxAttempts: 2,
        initialInterval: 1,
        retryOn: (e) => e?.message === "try again",
      },
    },
  )
  .addEdge(START, "plan")
  .addConditionalEdges(
    "plan",
    (state) =>
      (state.topics ?? ["weather", "news"]).map(
        (topic) =>
          new Send("tools", {
            lg_tool_call: {
              id: `call_${topic}`,
              name: "task",
              args: { topic },
            },
            topic,
            askApproval: state.askApproval ?? false,
          }),
      ),
    ["tools"],
  )
  .addEdge("tools", END)
  .compile();
