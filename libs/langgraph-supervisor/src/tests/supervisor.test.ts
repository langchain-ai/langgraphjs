import { describe, it, expect } from "vitest";
import { z } from "zod";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import { tool } from "@langchain/core/tools";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { createSupervisor } from "../supervisor.js";
import { FakeToolCallingChatModel } from "./utils.js";
import { withAgentName, AgentNameMode } from "../index.js";

describe("Test supervisor basic workflow", () => {
  // Define the test cases
  it.each([
    // [description, supervisorAgentName, individualAgentName]
    ["without agent name configuration", undefined, undefined],
    ["with supervisor agent name", "inline" as const, undefined],
    ["with individual agent names", undefined, "inline" as const],
    [
      "with both supervisor and individual agent names",
      "inline" as const,
      "inline" as const,
    ],
  ])(
    "basic supervisor workflow %s",
    async (
      _description: string,
      includeAgentName: AgentNameMode | undefined,
      includeIndividualAgentName: AgentNameMode | undefined
    ) => {
      // Define mock responses for the agents
      const supervisorMessages = [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "transfer_to_research_expert",
              args: {},
              id: "call_gyQSgJQm5jJtPcF5ITe8GGGF",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "transfer_to_math_expert",
              args: {},
              id: "call_zCExWE54g4B4oFZcwBh3Wumg",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content:
            "The combined headcount of the FAANG companies in 2024 is 1,977,586 employees.",
        }),
      ];

      const researchAgentMessages = [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "web_search",
              args: { query: "FAANG headcount 2024" },
              id: "call_4sLYp7usFcIZBFcNsOGQiFzV",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content:
            "The headcount for the FAANG companies in 2024 is as follows:\n\n1. **Facebook (Meta)**: 67,317 employees\n2. **Amazon**: 1,551,000 employees\n3. **Apple**: 164,000 employees\n4. **Netflix**: 14,000 employees\n5. **Google (Alphabet)**: 181,269 employees\n\nTo find the combined headcount, simply add these numbers together.",
        }),
      ];

      const mathAgentMessages = [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "add",
              args: { a: 67317, b: 1551000 },
              id: "call_BRvA6oAlgMA1whIkAn9gE3AS",
              type: "tool_call",
            },
            {
              name: "add",
              args: { a: 164000, b: 14000 },
              id: "call_OLVb4v0pNDlsBsKBwDK4wb1W",
              type: "tool_call",
            },
            {
              name: "add",
              args: { a: 181269, b: 0 },
              id: "call_5VEHaInDusJ9MU3i3tVJN6Hr",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "add",
              args: { a: 1618317, b: 178000 },
              id: "call_FdfUz8Gm3S5OQaVq2oQpMxeN",
              type: "tool_call",
            },
            {
              name: "add",
              args: { a: 181269, b: 0 },
              id: "call_j5nna1KwGiI60wnVHM2319r6",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "add",
              args: { a: 1796317, b: 181269 },
              id: "call_4fNHtFvfOvsaSPb8YK1qNAiR",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content:
            "The combined headcount of the FAANG companies in 2024 is 1,977,586 employees.",
        }),
      ];

      // Create models with mocked responses
      const mathModel = new FakeToolCallingChatModel({
        responses: mathAgentMessages,
      });

      const researchModel = new FakeToolCallingChatModel({
        responses: researchAgentMessages,
      });

      const supervisorModel = new FakeToolCallingChatModel({
        responses: supervisorMessages,
      });

      // Create specialized agents
      const add = tool(async (args) => args.a + args.b, {
        name: "add",
        description: "Add two numbers.",
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

      // Apply individual agent name mode if specified
      let mathLLM = mathModel as LanguageModelLike;
      if (includeIndividualAgentName) {
        mathLLM = withAgentName(
          mathModel.bindTools([add]),
          includeIndividualAgentName
        );
      }

      let researchLLM = researchModel as LanguageModelLike;
      if (includeIndividualAgentName) {
        researchLLM = withAgentName(
          researchModel.bindTools([webSearch]),
          includeIndividualAgentName
        );
      }

      const mathAgent = createReactAgent({
        llm: mathLLM,
        tools: [add],
        name: "math_expert",
        description: "Math expert.",
        prompt: "You are a math expert. Always use one tool at a time.",
      });

      const researchAgent = createReactAgent({
        llm: researchLLM,
        tools: [webSearch],
        name: "research_expert",
        description: "World class researcher with access to web search.",
        prompt:
          "You are a world class researcher with access to web search. Do not do any math.",
      });

      // Create supervisor workflow with "last_message" output mode
      const workflow = createSupervisor({
        agents: [mathAgent, researchAgent],
        llm: supervisorModel,
        prompt:
          "You are a team supervisor managing a research expert and a math expert.",
        includeAgentName,
      });

      const toolNode = (
        workflow.nodes.supervisor.runnable as ReturnType<
          typeof createReactAgent
        >
      ).nodes.tools.bound as ToolNode;

      expect(toolNode.tools).toMatchObject([
        { name: "transfer_to_math_expert", description: "Math expert." },
        {
          name: "transfer_to_research_expert",
          description: "World class researcher with access to web search.",
        },
      ]);

      const app = workflow.compile();
      expect(app).toBeDefined();

      const result = await app.invoke({
        messages: [
          new HumanMessage({
            content:
              "what's the combined headcount of the FAANG companies in 2024?",
          }),
        ],
      });

      expect(result).toBeDefined();
      const resultObj = result as (typeof MessagesAnnotation)["State"];

      expect(resultObj.messages).toBeDefined();

      // Match Python test assertions
      expect(resultObj.messages.length).toBe(12);

      // first supervisor handoff
      expect(resultObj.messages[1]).toEqual(supervisorMessages[0]);

      // last research agent message
      expect(resultObj.messages[3]).toEqual(researchAgentMessages.at(-1));

      // next supervisor handoff
      expect(resultObj.messages[6]).toEqual(supervisorMessages[1]);

      // last math agent message
      expect(resultObj.messages[8]).toEqual(mathAgentMessages.at(-1));

      // final supervisor message
      expect(resultObj.messages[11]).toEqual(supervisorMessages.at(-1));

      // Test with "full_history" output mode
      const workflowFullHistory = createSupervisor({
        agents: [mathAgent, researchAgent],
        llm: supervisorModel,
        prompt:
          "You are a team supervisor managing a research expert and a math expert.",
        outputMode: "full_history",
        includeAgentName,
      });

      const appFullHistory = workflowFullHistory.compile();
      const resultFullHistory = await appFullHistory.invoke({
        messages: [
          new HumanMessage({
            content:
              "what's the combined headcount of the FAANG companies in 2024?",
          }),
        ],
      });

      expect(resultFullHistory).toBeDefined();
      const resultFullHistoryObj =
        resultFullHistory as (typeof MessagesAnnotation)["State"];
      expect(resultFullHistoryObj.messages).toBeDefined();

      // Match Python test assertions for full_history
      expect(resultFullHistoryObj.messages.length).toBe(23);

      // first supervisor handoff
      expect(resultFullHistoryObj.messages[1]).toEqual(supervisorMessages[0]);

      // all research agent AI messages
      expect(resultFullHistoryObj.messages[3]).toEqual(
        researchAgentMessages[0]
      );
      expect(resultFullHistoryObj.messages[5]).toEqual(
        researchAgentMessages[1]
      );

      // next supervisor handoff
      expect(resultFullHistoryObj.messages[8]).toEqual(supervisorMessages[1]);

      // all math agent AI messages
      expect(resultFullHistoryObj.messages[10]).toEqual(mathAgentMessages[0]);
      expect(resultFullHistoryObj.messages[14]).toEqual(mathAgentMessages[1]);
      expect(resultFullHistoryObj.messages[17]).toEqual(mathAgentMessages[2]);

      // final supervisor message
      expect(resultFullHistoryObj.messages.at(-1)).toEqual(
        supervisorMessages.at(-1)
      );
    }
  );
});
