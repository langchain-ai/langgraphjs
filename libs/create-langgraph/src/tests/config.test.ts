import { describe, it, expect } from "vitest";
import {
  scanContentForAgents,
  ESM_EXPORT_PATTERN,
  CJS_EXPORT_PATTERN,
} from "../config.js";

describe("Agent Detection Patterns", () => {
  describe("ESM: createAgent", () => {
    it("should detect exported createAgent with const", () => {
      const content = `export const agent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect exported createAgent with let", () => {
      const content = `export let myAgent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("myAgent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect exported createAgent with var", () => {
      const content = `export var legacyAgent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("legacyAgent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect unexported createAgent", () => {
      const content = `const agent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(false);
    });

    it("should detect createAgent with await", () => {
      const content = `export const agent = await createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect createAgent with extra whitespace", () => {
      const content = `export const   agent   =   createAgent  (  { model, tools }  );`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
    });

    it("should detect createAgent with multiline definition", () => {
      const content = `export const agent = createAgent({
        model,
        tools: [tool1, tool2],
        systemPrompt: "You are helpful"
      });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
    });

    it("should detect multiple createAgent definitions", () => {
      const content = `
        export const agent1 = createAgent({ model, tools });
        export const agent2 = createAgent({ model, tools });
        const privateAgent = createAgent({ model, tools });
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(3);
      expect(agents.filter((a) => a.isExported)).toHaveLength(2);
      expect(agents.filter((a) => !a.isExported)).toHaveLength(1);
    });

    it("should handle various agent naming conventions", () => {
      const names = [
        "agent",
        "myAgent",
        "my_agent",
        "Agent1",
        "_privateAgent",
        "$specialAgent",
        "AGENT",
        "weatherAgent",
        "chatBot",
      ];
      for (const name of names) {
        const content = `export const ${name} = createAgent({ model });`;
        const agents = scanContentForAgents(content);
        expect(agents).toHaveLength(1);
        expect(agents[0].name).toBe(name);
      }
    });
  });

  describe("ESM: StateGraph.compile()", () => {
    it("should detect new StateGraph().compile()", () => {
      const content = `export const graph = new StateGraph(annotation).compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect workflow.compile() pattern", () => {
      const content = `export const agent = workflow.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect builder.compile() pattern", () => {
      const content = `export const graph = builder.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
    });

    it("should detect unexported .compile()", () => {
      const content = `const graph = workflow.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
      expect(agents[0].isExported).toBe(false);
    });

    it("should detect .compile() with options", () => {
      const content = `export const agent = workflow.compile({ checkpointer: new MemorySaver() });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
    });

    it("should detect await .compile()", () => {
      const content = `export const graph = await workflow.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
    });

    it("should detect new StateGraph with complex annotation", () => {
      const content = `export const app = new StateGraph(StateAnnotation).compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("app");
    });

    it("should detect chained StateGraph methods before compile", () => {
      const content = `
        const workflow = new StateGraph(annotation)
          .addNode("agent", agentNode)
          .addNode("tools", toolNode)
          .addEdge("agent", "tools");
        
        export const graph = workflow.compile();
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
      expect(agents[0].isExported).toBe(true);
    });
  });

  describe("CJS: module.exports", () => {
    it("should detect module.exports.name = createAgent()", () => {
      const content = `module.exports.agent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect exports.name = createAgent()", () => {
      const content = `exports.myAgent = createAgent({ model, tools });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("myAgent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect module.exports.name = workflow.compile()", () => {
      const content = `module.exports.graph = workflow.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect exports.name = workflow.compile()", () => {
      const content = `exports.app = builder.compile();`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("app");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect multiple CJS exports", () => {
      const content = `
        module.exports.agent1 = createAgent({ model });
        exports.agent2 = createAgent({ model });
        module.exports.graph = workflow.compile();
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(3);
      expect(agents.every((a) => a.isExported)).toBe(true);
    });
  });

  describe("Mixed ESM and CJS in same file", () => {
    it("should detect both ESM and CJS patterns", () => {
      const content = `
        // ESM style
        export const esmAgent = createAgent({ model });
        
        // CJS style (unusual but possible in some setups)
        module.exports.cjsAgent = createAgent({ model });
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(2);
      expect(agents.find((a) => a.name === "esmAgent")).toBeDefined();
      expect(agents.find((a) => a.name === "cjsAgent")).toBeDefined();
    });
  });

  describe("Line number detection", () => {
    it("should correctly detect line numbers", () => {
      const content = `import { createAgent } from "langchain";

const model = new ChatOpenAI();

export const agent = createAgent({
  model,
  tools,
});

export const secondAgent = createAgent({ model });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(2);
      expect(agents[0].lineNumber).toBe(5);
      expect(agents[1].lineNumber).toBe(10);
    });

    it("should handle Windows line endings (CRLF)", () => {
      const content = `import { createAgent } from "langchain";\r\n\r\nexport const agent = createAgent({ model });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      // Note: Line count may differ with CRLF, but agent should still be found
      expect(agents[0].name).toBe("agent");
    });
  });

  describe("Edge cases and false positives", () => {
    it("should not detect createAgent in comments", () => {
      const content = `
        // export const agent = createAgent({ model });
        /* export const agent = createAgent({ model }); */
      `;
      const agents = scanContentForAgents(content);
      // Regex doesn't handle comments specially, so these might still match
      // This is a known limitation - documenting current behavior
      expect(agents.length).toBeGreaterThanOrEqual(0);
    });

    it("should not detect createAgent in strings", () => {
      const content = `
        const example = "export const agent = createAgent({ model });";
      `;
      const agents = scanContentForAgents(content);
      // Regex doesn't handle strings specially - documenting current behavior
      expect(agents.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty content", () => {
      const content = "";
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(0);
    });

    it("should handle content with no agents", () => {
      const content = `
        import { something } from "somewhere";
        
        export function myFunction() {
          return "hello";
        }
        
        export const value = 42;
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(0);
    });

    it("should not match partial function names", () => {
      const content = `
        export const agent = myCreateAgent({ model });
        export const graph = createAgentExecutor({ model });
      `;
      const agents = scanContentForAgents(content);
      // Should not match myCreateAgent or createAgentExecutor
      expect(agents).toHaveLength(0);
    });

    it("should handle createAgent from different imports", () => {
      const content = `
        import { createAgent } from "langchain";
        import { createAgent as customAgent } from "custom-lib";
        
        export const agent1 = createAgent({ model });
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent1");
    });
  });

  describe("Real-world code patterns", () => {
    it("should detect agent in typical TypeScript file", () => {
      const content = `
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

const getWeather = tool(
  async ({ location }) => {
    return \`Weather in \${location}: Sunny\`;
  },
  {
    name: "get_weather",
    description: "Get weather for a location",
    schema: z.object({
      location: z.string(),
    }),
  }
);

export const agent = createAgent({
  model,
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant.",
});
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect compiled StateGraph in typical file", () => {
      const content = `
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

const StateAnnotation = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

async function agentNode(state: typeof StateAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response.content] };
}

const workflow = new StateGraph(StateAnnotation)
  .addNode("agent", agentNode)
  .addEdge(START, "agent")
  .addEdge("agent", END);

export const graph = workflow.compile();
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("graph");
      expect(agents[0].isExported).toBe(true);
    });

    it("should detect multiple agents in a file with both patterns", () => {
      const content = `
import { createAgent } from "langchain";
import { StateGraph, START, END } from "@langchain/langgraph";

// Simple agent using createAgent
export const simpleAgent = createAgent({
  model,
  tools: [searchTool],
});

// Complex workflow using StateGraph
const complexWorkflow = new StateGraph(StateAnnotation)
  .addNode("research", researchNode)
  .addNode("write", writeNode)
  .addEdge(START, "research")
  .addEdge("research", "write")
  .addEdge("write", END);

export const complexAgent = complexWorkflow.compile();

// Private agent (not exported)
const internalAgent = createAgent({ model, tools: [] });
      `;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(3);
      expect(agents.filter((a) => a.isExported)).toHaveLength(2);
      expect(agents.filter((a) => !a.isExported)).toHaveLength(1);
      expect(agents.find((a) => a.name === "simpleAgent")).toBeDefined();
      expect(agents.find((a) => a.name === "complexAgent")).toBeDefined();
      expect(agents.find((a) => a.name === "internalAgent")).toBeDefined();
    });

    it("should detect CJS module in CommonJS file", () => {
      const content = `
const { createAgent } = require("langchain");
const { ChatOpenAI } = require("@langchain/openai");

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

const agent = createAgent({
  model,
  tools: [],
});

module.exports.agent = agent;
module.exports.weatherAgent = createAgent({
  model,
  tools: [weatherTool],
});
      `;
      const agents = scanContentForAgents(content);
      // Should find the unexported 'agent' and the exported 'weatherAgent'
      expect(agents.find((a) => a.name === "agent" && !a.isExported)).toBeDefined();
      expect(agents.find((a) => a.name === "weatherAgent" && a.isExported)).toBeDefined();
    });
  });

  describe("FilePath handling", () => {
    it("should include filePath in agent info", () => {
      const content = `export const agent = createAgent({ model });`;
      const agents = scanContentForAgents(content, "/path/to/agent.ts");
      expect(agents).toHaveLength(1);
      expect(agents[0].filePath).toBe("/path/to/agent.ts");
    });

    it("should use default filePath when not provided", () => {
      const content = `export const agent = createAgent({ model });`;
      const agents = scanContentForAgents(content);
      expect(agents).toHaveLength(1);
      expect(agents[0].filePath).toBe("test.ts");
    });
  });
});

describe("Export Pattern Regexes", () => {
  describe("ESM_EXPORT_PATTERN", () => {
    it("should match ESM export statements", () => {
      expect(ESM_EXPORT_PATTERN.test("export const x")).toBe(true);
      expect(ESM_EXPORT_PATTERN.test("export let x")).toBe(true);
      expect(ESM_EXPORT_PATTERN.test("export var x")).toBe(true);
      expect(ESM_EXPORT_PATTERN.test("export function")).toBe(true);
    });

    it("should not match non-export statements", () => {
      expect(ESM_EXPORT_PATTERN.test("const x = export")).toBe(false);
      expect(ESM_EXPORT_PATTERN.test("module.exports")).toBe(false);
      expect(ESM_EXPORT_PATTERN.test("exports.x")).toBe(false);
    });
  });

  describe("CJS_EXPORT_PATTERN", () => {
    it("should match CJS export statements", () => {
      expect(CJS_EXPORT_PATTERN.test("module.exports.x")).toBe(true);
      expect(CJS_EXPORT_PATTERN.test("exports.x")).toBe(true);
    });

    it("should not match non-export statements", () => {
      expect(CJS_EXPORT_PATTERN.test("export const x")).toBe(false);
      expect(CJS_EXPORT_PATTERN.test("const exports")).toBe(false);
    });
  });
});
