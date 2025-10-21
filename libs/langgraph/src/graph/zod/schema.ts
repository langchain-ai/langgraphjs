/**
 * This package provides a canonical (non-scoped) package name for LangGraph.
 *
 * The `langgraph` package re-exports all functionality from `@langchain/langgraph`
 * - `npm install langgraph` (canonical name)
 * - `npm install @langchain/langgraph` (scoped name)
 *
 * Both packages provide identical exports, with this package serving as
 * a convenience wrapper for those who prefer the simpler package name.
 */
export * from "@langchain/langgraph/zod/schema";
