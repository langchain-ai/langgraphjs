import assert from "node:assert/strict";
import { Annotation, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { GraphFactoryRuntime } from "../../src/graph/api.mjs";

export const graph = (
  config: { configurable?: Record<string, unknown> },
  runtime: GraphFactoryRuntime<Record<string, unknown>>
) => {
  const context = runtime.executionRuntime?.context;
  if (context?.reject) throw new Error("Factory rejected context");

  const compiled = new StateGraph(
    Annotation.Root({
      factoryContext: Annotation<unknown>(),
      nodeContext: Annotation<unknown>(),
      accessContext: Annotation<string>(),
      legacy: Annotation<unknown>(),
      answer: Annotation<unknown>(),
    })
  )
    .addNode("capture", (_, nodeRuntime) => ({
      factoryContext: context ?? null,
      nodeContext: nodeRuntime.context ?? null,
      accessContext: runtime.accessContext,
      legacy: config.configurable?.legacy ?? null,
      answer: context?.interrupt ? interrupt("Continue?") : null,
    }))
    .addEdge(START, "capture")
    .compile();

  // Verify the operation that loaded the factory, at the real API call site.
  const getState = compiled.getState.bind(compiled);
  compiled.getState = (...args) => {
    assert.equal(runtime.accessContext, "threads.read");
    return getState(...args);
  };
  const getStateHistory = compiled.getStateHistory.bind(compiled);
  compiled.getStateHistory = (...args) => {
    assert.equal(runtime.accessContext, "threads.read");
    return getStateHistory(...args);
  };
  const updateState = compiled.updateState.bind(compiled);
  compiled.updateState = (...args) => {
    assert.equal(runtime.accessContext, "threads.update");
    return updateState(...args);
  };
  const bulkUpdateState = compiled.bulkUpdateState.bind(compiled);
  compiled.bulkUpdateState = (...args) => {
    assert.equal(runtime.accessContext, "threads.update");
    return bulkUpdateState(...args);
  };
  return compiled;
};
