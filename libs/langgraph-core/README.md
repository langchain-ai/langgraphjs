<div align="center">
  <a href="https://www.langchain.com/langgraph">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="LangGraph Logo" src=".github/images/logo-dark.svg" width="50%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>Low-level orchestration framework for building stateful agents.</h3>
</div>

<div align="center">
  <a href="https://docs.langchain.com/oss/javascript/langgraph/overview" target="_blank"><img src="https://img.shields.io/badge/docs-latest-blue" alt="Docs"></a>
  <a href="https://www.npmjs.com/package/@langchain/langgraph" target="_blank"><img src="https://img.shields.io/npm/v/@langchain/langgraph?logo=npm" alt="Version"></a>
  <a href="https://www.npmjs.com/package/@langchain/langgraph" target="_blank"><img src="https://img.shields.io/npm/dm/@langchain/langgraph" alt="npm - Downloads"></a>
  <a href="https://github.com/langchain-ai/langgraphjs/issues" target="_blank"><img src="https://img.shields.io/github/issues-raw/langchain-ai/langgraphjs" alt="Open Issues"></a>
</div>

LangGraph — used by Replit, Uber, LinkedIn, GitLab and more — is a low-level orchestration framework for building controllable agents. While langchain provides integrations and composable components to streamline LLM application development, the LangGraph library enables agent orchestration — offering customizable architectures, long-term memory, and human-in-the-loop to reliably handle complex tasks.

```bash
npm install @langchain/langgraph @langchain/core
```

> [!TIP]
> If you're looking to quickly build agents, check out **[Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview)** — a higher-level package built on LangGraph for agents that can plan, use subagents, and leverage file systems for complex tasks.

To learn more about how to use LangGraph, check out [the docs](https://langchain-ai.github.io/langgraphjs/). We show a simple example below of how to create a ReAct agent.

```ts
import {
  StateSchema,
  MessagesValue,
  StateGraph,
  START,
  END,
  type GraphNode
} from "@langchain/langgraph";

const State = new StateSchema({
  messages: MessagesValue,
});

const mockLlm: GraphNode<typeof State> = (state) => {
  return { messages: [{ role: "ai", content: "hello world" }] };
};

const graph = new StateGraph(State)
  .addNode("mock_llm", mockLlm)
  .addEdge(START, "mock_llm")
  .addEdge("mock_llm", END)
  .compile();

await graph.invoke({ messages: [{ role: "user", content: "hi!" }] });
```

For an equivalent Python library, check out [LangGraph](https://github.com/langchain-ai/langgraph) and the [Python docs](https://docs.langchain.com/oss/python/langgraph/overview).

## Why use LangGraph?

LangGraph provides low-level supporting infrastructure for *any* long-running, stateful workflow or agent:

- **[Durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)** — Build agents that persist through failures and can run for extended periods, automatically resuming from exactly where they left off.
- **[Human-in-the-loop](https://docs.langchain.com/oss/javascript/langgraph/interrupts)** — Seamlessly incorporate human oversight by inspecting and modifying agent state at any point during execution.
- **[Comprehensive memory](https://docs.langchain.com/oss/javascript/langgraph/memory)** — Create truly stateful agents with both short-term working memory for ongoing reasoning and long-term persistent memory across sessions.
- **[Debugging with LangSmith](https://www.langchain.com/langsmith)** — Gain deep visibility into complex agent behavior with visualization tools that trace execution paths, capture state transitions, and provide detailed runtime metrics.
- **[Production-ready deployment](https://docs.langchain.com/langsmith/deployments)** — Deploy sophisticated agent systems confidently with scalable infrastructure designed to handle the unique challenges of stateful, long-running workflows.

> [!TIP]
> For developing, debugging, and deploying AI agents and LLM applications, see [LangSmith](https://docs.langchain.com/langsmith/home).

LangGraph is trusted in production and powering agents for companies like:

- [Klarna](https://blog.langchain.dev/customers-klarna/): Customer support bot for 85 million active users
- [Elastic](https://www.elastic.co/blog/elastic-security-generative-ai-features): Security AI assistant for threat detection
- [Uber](https://dpe.org/sessions/ty-smith-adam-huda/this-year-in-ubers-ai-driven-developer-productivity-revolution/): Automated unit test generation
- [Replit](https://www.langchain.com/breakoutagents/replit): Code generation
- And many more ([see list here](https://www.langchain.com/built-with-langgraph))

## LangGraph’s ecosystem

While LangGraph can be used standalone, it also integrates seamlessly with any LangChain product, giving developers a full suite of tools for building agents. To improve your LLM application development, pair LangGraph with:

- [Deep Agents (JS)](https://docs.langchain.com/oss/javascript/deepagents/overview) — Build agents that can plan, use subagents, and leverage file systems for complex tasks. A higher-level package built on top of LangGraph.
- [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) – Provides integrations and composable components to streamline LLM application development.
- [LangSmith](http://www.langchain.com/langsmith) — Helpful for agent evals and observability. Debug poor-performing LLM app runs, evaluate agent trajectories, gain visibility in production, and improve performance over time.

## Pairing with LangGraph Platform

While LangGraph is our open-source agent orchestration framework, enterprises that need scalable agent deployment can benefit from [LangGraph Platform](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_platform/).

LangGraph Platform can help engineering teams:

- **Accelerate agent development**: Quickly create agent UXs with configurable templates and [LangGraph Studio](https://langchain-ai.github.io/langgraphjs/concepts/langgraph_studio/) for visualizing and debugging agent interactions.
- **Deploy seamlessly**: We handle the complexity of deploying your agent. LangGraph Platform includes robust APIs for memory, threads, and cron jobs plus auto-scaling task queues & servers.
- **Centralize agent management & reusability**: Discover, reuse, and manage agents across the organization. Business users can also modify agents without coding.

## Additional resources

- [LangChain Forum](https://forum.langchain.com/): Connect with the community and share all of your technical questions, ideas, and feedback.
- [LangChain Academy](https://academy.langchain.com/courses/intro-to-langgraph): Learn the basics of LangGraph in our free, structured course.
- [Streaming Cookbook](https://github.com/langchain-ai/streaming-cookbook): Documentation and examples around LangGraphs's streaming capabilities.
- [API Reference](https://reference.langchain.com/javascript/langchain-langgraph): Detailed reference on core classes, methods, how to use the graph and checkpointing APIs, and higher-level prebuilt components.
- [Built with LangGraph](https://www.langchain.com/built-with-langgraph): Hear how industry leaders use LangGraph to ship powerful, production-ready AI applications.

## Acknowledgements

LangGraph is inspired by [Pregel](https://research.google/pubs/pub37252/) and [Apache Beam](https://beam.apache.org/). The public interface draws inspiration from [NetworkX](https://networkx.org/documentation/latest/). LangGraph is built by LangChain Inc, the creators of LangChain, but can be used without LangChain.
