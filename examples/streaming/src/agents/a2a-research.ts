/**
 * Research pipeline compiled with an A2A stream transformer.
 *
 * This is the same research pipeline from `./research-pipeline.ts` but
 * compiled with `transformers: [createA2ATransformer]` so A2A events are
 * automatically emitted during every `streamEvents(..., { version: "v3" })` call — including
 * when the graph is deployed and run through the LangGraph API server.
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

import { createA2ATransformer } from "../shared/a2a-transformer.js";
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

/**
 * The compiled graph with A2A reducer baked in.
 *
 * When deployed via `langgraph.json`, the API server detects
 * `graph.streamTransformers` and routes execution through `streamStateV2()`,
 * which runs the A2A transformer server-side. A2A events flow to clients
 * as protocol events on the `custom` channel.
 */
export const graph = new StateGraph(MessagesAnnotation)
  .addNode("researcher", researcherGraph)
  .addNode("analyst", analystGraph)
  .addEdge(START, "researcher")
  .addEdge("researcher", "analyst")
  .addEdge("analyst", END)
  .compile({ transformers: [createA2ATransformer] });
