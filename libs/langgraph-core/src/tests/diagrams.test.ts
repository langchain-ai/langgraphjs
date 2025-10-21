import { test, expect } from "vitest";
import { createReactAgent } from "../prebuilt/index.js";
import { FakeSearchTool } from "./utils.js";
import { FakeToolCallingChatModel } from "./utils.models.js";
import { Annotation, StateGraph } from "../web.js";

test("prebuilt agent", async () => {
  // Define the tools for the agent to use
  const tools = [new FakeSearchTool()];

  const model = new FakeToolCallingChatModel({});

  const app = createReactAgent({ llm: model, tools });

  const graph = app.getGraph();
  const mermaid = graph.drawMermaid();
  expect(mermaid).toEqual(`%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
\t__start__([<p>__start__</p>]):::first
\ttools(tools)
\tagent(agent)
\t__end__([<p>__end__</p>]):::last
\t__start__ --> agent;
\ttools --> agent;
\tagent -.-> tools;
\tagent -.-> __end__;
\tclassDef default fill:#f2f0ff,line-height:1.2;
\tclassDef first fill-opacity:0;
\tclassDef last fill:#bfb6fc;
`);
});

test("graph with multiple sinks", async () => {
  const StateAnnotation = Annotation.Root({});
  const app = new StateGraph(StateAnnotation)
    .addNode("inner1", async () => {})
    .addNode("inner2", async () => {})
    .addNode("inner3", async () => {})
    .addEdge("__start__", "inner1")
    .addConditionalEdges("inner1", async () => "inner2", ["inner2", "inner3"])
    .compile();

  const graph = app.getGraph();
  const mermaid = graph.drawMermaid();
  expect(mermaid).toEqual(`%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
\t__start__([<p>__start__</p>]):::first
\tinner1(inner1)
\tinner2(inner2)
\tinner3(inner3)
\t__start__ --> inner1;
\tinner1 -.-> inner2;
\tinner1 -.-> inner3;
\tclassDef default fill:#f2f0ff,line-height:1.2;
\tclassDef first fill-opacity:0;
\tclassDef last fill:#bfb6fc;
`);
});

test("graph with subgraphs", async () => {
  const SubgraphStateAnnotation = Annotation.Root({});
  const subgraph = new StateGraph(SubgraphStateAnnotation)
    .addNode("inner1", async () => {})
    .addNode("inner2", async () => {})
    .addNode("inner3", async () => {})
    .addEdge("__start__", "inner1")
    .addConditionalEdges("inner1", async () => "inner2", ["inner2", "inner3"])
    .compile();

  const StateAnnotation = Annotation.Root({});

  const app = new StateGraph(StateAnnotation)
    .addNode("starter", async () => {})
    .addNode("inner", subgraph)
    .addNode("final", async () => {})
    .addEdge("__start__", "starter")
    .addConditionalEdges("starter", async () => "final", ["inner", "final"])
    .compile({ interruptBefore: ["starter"] });

  const graph = app.getGraph({ xray: true });
  const mermaid = graph.drawMermaid();
  expect(mermaid).toEqual(`%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
\t__start__([<p>__start__</p>]):::first
\tstarter(starter<hr/><small><em>__interrupt = before</em></small>)
\tinner_inner1(inner1)
\tinner_inner2(inner2)
\tinner_inner3(inner3)
\tfinal(final)
\t__start__ --> starter;
\tstarter -.-> inner_inner1;
\tstarter -.-> final;
\tsubgraph inner
\tinner_inner1 -.-> inner_inner2;
\tinner_inner1 -.-> inner_inner3;
\tend
\tclassDef default fill:#f2f0ff,line-height:1.2;
\tclassDef first fill-opacity:0;
\tclassDef last fill:#bfb6fc;
`);
});
