import { test, expect } from "@jest/globals";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatOpenAI } from "@langchain/openai";
// Define the tools for the agent to use
import { createReactAgent } from "../prebuilt/index.js";

test.only("langgraph", async () => {
  // Define the tools for the agent to use
  const tools = [new TavilySearchResults({ maxResults: 1 })];

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
