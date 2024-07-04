import { test, expect } from "@jest/globals";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "../prebuilt/index.js";
import { FakeSearchTool } from "./utils.js";

test("prebuilt agent", async () => {
  // Define the tools for the agent to use
  const tools = [new FakeSearchTool()];

  const model = new ChatOpenAI({ temperature: 0 });

  const app = createReactAgent({ llm: model, tools });

  const graph = app.getGraph();
  const mermaid = graph.drawMermaid();
  expect(mermaid).toEqual(`%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
\t__start__[__start__]:::startclass;
\t__end__[__end__]:::endclass;
\tagent([agent]):::otherclass;
\ttools([tools]):::otherclass;
\t__start__ --> agent;
\ttools --> agent;
\tagent -. continue .-> tools;
\tagent -.-> __end__;
\tclassDef startclass fill:#ffdfba;
\tclassDef endclass fill:#baffc9;
\tclassDef otherclass fill:#fad7de;
`);
});
