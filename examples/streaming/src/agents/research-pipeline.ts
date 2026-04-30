/**
 * Research pipeline: researcher subgraph → analyst subgraph.
 *
 * Two subgraphs with separate tool sets, wired sequentially.
 * Demonstrates how streamEvents(..., { version: "v3" }) exposes subgraph events hierarchically.
 */

import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "langchain";
import { z } from "zod/v4";

import { model, searchWeb } from "./shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const summarize = tool(
  async ({ text, format }: { text: string; format: "bullets" | "prose" }) => {
    await sleep(200);
    const lines =
      format === "bullets"
        ? text
            .split(".")
            .filter(Boolean)
            .map((s) => `- ${s.trim()}`)
        : [text];
    return JSON.stringify({ summary: lines.join("\n") });
  },
  {
    name: "summarize",
    description: "Summarize text into bullets or prose.",
    schema: z.object({
      text: z.string(),
      format: z.enum(["bullets", "prose"]),
    }),
  }
);

const scoreRisks = tool(
  async ({ risks }: { risks: string[] }) => {
    await sleep(150);
    return JSON.stringify({
      scored: risks.map((risk, i) => ({
        risk,
        severity: i % 2 === 0 ? "high" : "medium",
      })),
    });
  },
  {
    name: "score_risks",
    description: "Score a list of risks by severity.",
    schema: z.object({ risks: z.array(z.string()) }),
  }
);

const researcherModel = model.bindTools([searchWeb, summarize]);
const researcherTools = new ToolNode([searchWeb, summarize]);

const researcherGraph = new StateGraph(MessagesAnnotation)
  .addNode("researcher", async (state) => ({
    messages: [
      await researcherModel.invoke([
        new SystemMessage(
          "You are a research agent. Search for the topic, then summarize findings as bullets."
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
      return last.tool_calls?.length ? "tools" : END;
    },
    ["tools", END]
  )
  .addEdge("tools", "researcher")
  .compile();

const analystModel = model.bindTools([scoreRisks]);
const analystTools = new ToolNode([scoreRisks]);

const analystGraph = new StateGraph(MessagesAnnotation)
  .addNode("analyst", async (state) => ({
    messages: [
      await analystModel.invoke([
        new SystemMessage(
          "You are a risk analyst. Read the research, identify 3 risks, and score them."
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
      return last.tool_calls?.length ? "tools" : END;
    },
    ["tools", END]
  )
  .addEdge("tools", "analyst")
  .compile();

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("researcher", researcherGraph)
  .addNode("analyst", analystGraph)
  .addEdge(START, "researcher")
  .addEdge("researcher", "analyst")
  .addEdge("analyst", END)
  .compile();
