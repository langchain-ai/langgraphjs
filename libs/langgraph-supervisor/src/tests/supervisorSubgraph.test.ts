import { z } from "zod";
import { tool } from "@langchain/core/tools";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { describe, expect, it } from "vitest";
import {
  FakeChatModel,
  FakeStreamingChatModel,
} from "@langchain/core/utils/testing";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createSupervisor } from "../supervisor.js";

const __dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("Supervisor", () => {
  it("should be drawable as subgraph", async () => {
    const getSubGraph = async () => {
      const model = new FakeChatModel({});
      model.bindTools = () => {
        return model;
      };

      // Create specialized agents
      const add = tool(async (args) => args.a + args.b, {
        name: "add",
        description: "Add two numbers.",
        schema: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      const multiply = tool(async (args) => args.a * args.b, {
        name: "multiply",
        description: "Multiply two numbers.",
        schema: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      const webSearch = tool(
        async (_args) => {
          return (
            "Here are the headcounts for each of the FAANG companies in 2024:\n" +
            "1. **Facebook (Meta)**: 67,317 employees.\n" +
            "2. **Apple**: 164,000 employees.\n" +
            "3. **Amazon**: 1,551,000 employees.\n" +
            "4. **Netflix**: 14,000 employees.\n" +
            "5. **Google (Alphabet)**: 181,269 employees."
          );
        },
        {
          name: "web_search",
          description: "Search the web for information.",
          schema: z.object({
            query: z.string(),
          }),
        }
      );

      const mathAgent = createReactAgent({
        llm: model,
        tools: [add, multiply],
        name: "math_expert",
        prompt: "You are a math expert. Always use one tool at a time.",
      });

      const researchAgent = createReactAgent({
        llm: model,
        tools: [webSearch],
        name: "research_expert",
        prompt:
          "You are a world class researcher with access to web search. Do not do any math.",
      });

      // Create supervisor workflow
      const workflow = createSupervisor({
        agents: [researchAgent, mathAgent],
        llm: model,
        prompt:
          "You are a team supervisor managing a research expert and a math expert. " +
          "For current events, use research_agent. " +
          "For math problems, use math_agent.",
      });

      // Compile and run
      const app = workflow.compile({ name: "Test" });

      return app;
    };

    const subGraph = await getSubGraph();

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("sub_graph", subGraph)
      .addEdge(START, "sub_graph")
      .addEdge("sub_graph", END)
      .compile();

    const drawableGraph = await graph.getGraphAsync({
      xray: true,
    });

    expect(drawableGraph).toBeDefined();

    const mermaid = await drawableGraph.drawMermaid();
    expect(mermaid.length).toBeGreaterThan(0);
  });

  it("should work with multiple layers of supervision arranged as subgraphs", async () => {
    const RECORDED_MESSAGES_FILE = path.resolve(
      path.join(
        __dirname,
        "..",
        "resources",
        "recorded_messages_multiple_layers_of_supervision.json"
      )
    );

    if (!existsSync(RECORDED_MESSAGES_FILE)) {
      throw new Error("Recorded messages file not found!");
    }
    const recordedMessages = JSON.parse(
      readFileSync(RECORDED_MESSAGES_FILE, "utf8")
    );
    const model = new FakeStreamingChatModel({
      responses: recordedMessages,
    });
    model.bindTools = () => {
      return model;
    };

    // Create specialized agents
    const add = tool(async (args) => args.a + args.b, {
      name: "add",
      description: "Add two numbers.",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      verbose: true,
    });

    const multiply = tool(async (args) => args.a * args.b, {
      name: "multiply",
      description: "Multiply two numbers.",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      verbose: true,
    });

    const webSearch = tool(
      async (_args) => {
        return (
          "Here are the headcounts for each of the FAANG companies in 2024:\n" +
          "1. **Facebook (Meta)**: 67,317 employees.\n" +
          "2. **Apple**: 164,000 employees.\n" +
          "3. **Amazon**: 1,551,000 employees.\n" +
          "4. **Netflix**: 14,000 employees.\n" +
          "5. **Google (Alphabet)**: 181,269 employees."
        );
      },
      {
        name: "web_search",
        description: "Search the web for information.",
        schema: z.object({
          query: z.string(),
        }),
        verbose: true,
      }
    );

    const writingTool = tool(
      async (args) => {
        return `Drafted article about: ${args.topic}`;
      },
      {
        name: "write_article",
        description: "Write an article on a given topic.",
        schema: z.object({
          topic: z.string(),
        }),
        verbose: true,
      }
    );

    const publishingTool = tool(
      async (args) => {
        return `Published article: ${args.article}`;
      },
      {
        name: "publish_article",
        description: "Publish a written article.",
        schema: z.object({
          article: z.string(),
        }),
        verbose: true,
      }
    );

    const mathAgent = createReactAgent({
      llm: model,
      tools: [add, multiply],
      name: "math_expert",
      prompt: "You are a math expert. Always use one tool at a time.",
    });

    const researchAgent = createReactAgent({
      llm: model,
      tools: [webSearch],
      name: "research_expert",
      prompt:
        "You are a world class researcher with access to web search. Do not do any math.",
    });

    const writingAgent = createReactAgent({
      llm: model,
      tools: [writingTool],
      name: "writing_expert",
      prompt: "You are an expert writer. Focus on creating engaging content.",
    });

    const publishingAgent = createReactAgent({
      llm: model,
      tools: [publishingTool],
      name: "publishing_expert",
      prompt:
        "You are a publishing expert. Handle the publication process professionally.",
    });

    // Create team supervisors
    const researchTeam = createSupervisor({
      agents: [researchAgent, mathAgent],
      llm: model,
      prompt:
        "You are a research team supervisor. Coordinate research and math tasks effectively.",
    }).compile({ name: "research_team" });

    const writingTeam = createSupervisor({
      agents: [writingAgent, publishingAgent],
      llm: model,
      prompt:
        "You are a writing team supervisor. Coordinate content creation and publication.",
    }).compile({ name: "writing_team" });

    // Create top-level supervisor
    const topLevelSupervisor = createSupervisor({
      agents: [researchTeam, writingTeam],
      llm: model,
      prompt:
        "You are an executive supervisor coordinating research and writing teams. Delegate tasks appropriately.",
    }).compile({ name: "top_level_supervisor" });

    // topLevelSupervisor.debug = true;

    // Run the workflow
    const result = await topLevelSupervisor.invoke({
      messages: [
        {
          role: "user",
          content: "what's 1+1 ? Don't guess the answer rely on research_team",
        },
      ],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
