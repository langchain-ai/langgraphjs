# Repository instructions

<corridor>

## Corridor security analysis

When Corridor's `analyzePlan` tool is available, create a plan and use the tool to analyze it before generating or modifying code. Apply the resulting security guidance before writing code.

</corridor>

## Direction: LangGraph is a runtime

LangGraph is consolidating as the low-level runtime for agents and workflows:
graph execution, checkpointing, streaming, and interrupt/resume. Critical
production systems and agent harnesses run on it, so correctness and stability
come first. It is moving away from being a friendly SDK for building agents
directly; agent development belongs one layer up, on a harness — Deep Agents
(github.com/langchain-ai/deepagents, a separate repo) is the recommended one.

Optimize contributions for runtime correctness, reliability, performance, and
simplicity — not for the shortest agent example.

- One way to do each thing. A change never adds a way; removals are always
  deliberate (see below). The number of ways only goes down. No aliases,
  overloads, extra accepted types, implicit defaults, or customization hooks
  for convenience: ergonomics alone never justify new public surface.
- The mandate applies to everything that implements runtime behavior, in
  whichever repo it lives: the graph engine (`langgraph`, `langgraph-core`),
  the checkpointers (`checkpoint*`), and the server (`langgraph-api`). The
  client SDKs and CLI stay ergonomic but are thin, faithful clients, never a
  second implementation of runtime behavior.
- Agent-level packages (`prebuilt`, `langgraph-supervisor`, `langgraph-swarm`,
  `langgraph-cua`) are maintenance-only: fix bugs, don't add agent features.
  New examples and docs that build agents should use Deep Agents.
- Remove deliberately, not opportunistically. Removing or changing public
  behavior must be the stated purpose of the PR and go through the deprecation
  process — replacement in place, removal version recorded, migration note.
  Never drop a default or overload as a side effect of an unrelated change.
- Behavior changes land in Python and JS together (the implementations live in
  separate repos; note in the PR when the other one needs a matching change).
- If a task asks for something this section rules out, say so and propose the
  runtime-level or harness-level alternative instead of quietly implementing it.
