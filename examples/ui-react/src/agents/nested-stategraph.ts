import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod/v4";

import { model, scoreRisks, searchWeb, summarizeFindings } from "./shared";

// ---------------------------------------------------------------------------
// Research subgraph: a researcher loop with its own tools. Keeps its tool
// chatter entirely inside the subgraph namespace — the only thing that flows
// back to the parent is a single "research brief" string.
// ---------------------------------------------------------------------------
const researcherModel = model.bindTools([searchWeb, summarizeFindings]);
const researcherTools = new ToolNode([searchWeb, summarizeFindings]);

const researcherSubgraph = new StateGraph(MessagesAnnotation)
  .addNode("researcher", async (state) => ({
    messages: [
      await researcherModel.invoke([
        new SystemMessage(
          `You are a research specialist. Call search_web to gather evidence,
then call summarize_findings to produce a crisp bullet list. When you are
done, reply with the bullet list as your final answer.`
        ),
        ...state.messages,
      ]),
    ],
  }))
  .addNode("tools", researcherTools)
  .addEdge(START, "researcher")
  .addConditionalEdges(
    "researcher",
    (state) => {
      const last = state.messages.at(-1) as AIMessage;
      return last?.tool_calls?.length ? "tools" : END;
    },
    ["tools", END]
  )
  .addEdge("tools", "researcher")
  .compile();

// ---------------------------------------------------------------------------
// Analysis subgraph: a risk analyst that reads the research brief, ranks
// risks, and emits a markdown report. Also isolated from parent state.
// ---------------------------------------------------------------------------
const analystModel = model.bindTools([scoreRisks]);
const analystTools = new ToolNode([scoreRisks]);

const analystSubgraph = new StateGraph(MessagesAnnotation)
  .addNode("analyst", async (state) => ({
    messages: [
      await analystModel.invoke([
        new SystemMessage(
          `You are a risk analyst. Read the research brief, enumerate 3 likely
risks, call score_risks to rank them by severity, then return a compact
markdown table as your final answer.`
        ),
        ...state.messages,
      ]),
    ],
  }))
  .addNode("tools", analystTools)
  .addEdge(START, "analyst")
  .addConditionalEdges(
    "analyst",
    (state) => {
      const last = state.messages.at(-1) as AIMessage;
      return last?.tool_calls?.length ? "tools" : END;
    },
    ["tools", END]
  )
  .addEdge("tools", "analyst")
  .compile();

// ---------------------------------------------------------------------------
// Parent state. `messages` is intentionally *decoupled* from the subgraphs:
// only the orchestrator and writer append to it. Each subgraph writes its
// distilled output to a dedicated artifact channel. This keeps the root
// conversation clean while the subgraph cards can still stream the full
// tool-calling chatter from their own namespace.
// ---------------------------------------------------------------------------
const NestedState = new StateSchema({
  messages: MessagesValue,
  researchBrief: z.string().default(""),
  riskReport: z.string().default(""),
});

const originalQuestion = (state: typeof NestedState.State): string => {
  const firstHuman = state.messages.find(HumanMessage.isInstance);
  return firstHuman?.text || "(no question supplied)";
};

// ---------------------------------------------------------------------------
// Parent nodes. Each subgraph is invoked from inside a parent node, which
// preserves namespaced subgraph lifecycle events but gives us full control
// over what lands in parent state.
// ---------------------------------------------------------------------------
async function orchestrator(state: typeof NestedState.State) {
  return {
    messages: [
      await model.invoke([
        new SystemMessage(
          `You are the orchestrator. Restate the user's research question in one
short sentence so the downstream subgraphs stay focused. Do not call any
tools.`
        ),
        ...state.messages,
      ]),
    ],
  };
}

async function research(state: typeof NestedState.State) {
  const question = originalQuestion(state);
  const result = await researcherSubgraph.invoke({
    messages: [new HumanMessage(question)],
  });
  const brief = result.messages.at(-1)?.text;
  return { researchBrief: brief };
}

async function analysis(state: typeof NestedState.State) {
  const prompt = [
    `Research brief:`,
    state.researchBrief || "(brief unavailable)",
    ``,
    `Question: ${originalQuestion(state)}`,
    ``,
    `Rank the top risks and return the markdown table.`,
  ].join("\n");
  const result = await analystSubgraph.invoke({
    messages: [new HumanMessage(prompt)],
  });
  const report = result.messages.at(-1)?.text;
  return { riskReport: report };
}

async function writer(state: typeof NestedState.State) {
  const context = [
    `Research brief:`,
    state.researchBrief || "(no brief)",
    ``,
    `Risk report:`,
    state.riskReport || "(no report)",
  ].join("\n");
  return {
    messages: [
      await model.invoke([
        new SystemMessage(
          `You are the final writer. Combine the research brief and the ranked
risks into a crisp briefing (about 120 words). Start with a one-line
summary, then bullets, then a short "recommendation:" line.`
        ),
        new HumanMessage(context),
      ]),
    ],
  };
}

export const agent = new StateGraph(NestedState)
  .addNode("orchestrator", orchestrator)
  .addNode("research", research, { subgraphs: [researcherSubgraph] })
  .addNode("analysis", analysis, { subgraphs: [analystSubgraph] })
  .addNode("writer", writer)
  .addEdge(START, "orchestrator")
  .addEdge("orchestrator", "research")
  .addEdge("research", "analysis")
  .addEdge("analysis", "writer")
  .addEdge("writer", END)
  .compile();
