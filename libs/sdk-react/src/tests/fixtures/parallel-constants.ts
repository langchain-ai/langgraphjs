/**
 * Fan-out widths shared between the Node-side graph fixtures and the
 * browser-side e2e test. Kept dependency-free (no `deepagents` /
 * `@langchain/langgraph` imports) so it is safe to import into the
 * browser test bundle, unlike the graph fixtures themselves.
 */

/** Number of parallel worker subagents the orchestrator fans out. */
export const FANOUT_WORKER_COUNT = 6;

/** Number of parallel subgraph executions the parent fans out. */
export const SUBGRAPH_WORKER_COUNT = 6;
