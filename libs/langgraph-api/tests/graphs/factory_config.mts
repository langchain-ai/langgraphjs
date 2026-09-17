import assert from "node:assert/strict";
import { Annotation, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { GraphFactoryConfig } from "../../src/graph/api.mjs";

interface TestContext {
  tenant?: string;
  region?: string;
  interrupt?: boolean;
  reject?: boolean;
}

export const graph = (config: GraphFactoryConfig<TestContext>) => {
  const context = config.context;
  if (context?.reject) throw new Error("Factory rejected context");

  const compiled = new StateGraph(
    Annotation.Root({
      factoryContext: Annotation<TestContext | null>(),
      nodeContext: Annotation<unknown>(),
      accessContext: Annotation<GraphFactoryConfig["accessContext"]>(),
      legacy: Annotation<unknown>(),
      answer: Annotation<unknown>(),
    })
  )
    .addNode("capture", (_, nodeRuntime) => ({
      factoryContext: context ?? null,
      nodeContext: nodeRuntime.context ?? null,
      accessContext: config.accessContext,
      legacy: config.configurable?.legacy ?? null,
      answer: context?.interrupt ? interrupt("Continue?") : null,
    }))
    .addEdge(START, "capture")
    .compile();

  const getState = compiled.getState.bind(compiled);
  compiled.getState = (...args) => {
    assert.equal(config.accessContext, "threads.read");
    return getState(...args);
  };
  const getStateHistory = compiled.getStateHistory.bind(compiled);
  compiled.getStateHistory = (...args) => {
    assert.equal(config.accessContext, "threads.read");
    return getStateHistory(...args);
  };
  const updateState = compiled.updateState.bind(compiled);
  compiled.updateState = (...args) => {
    assert.equal(config.accessContext, "threads.update");
    return updateState(...args);
  };
  const bulkUpdateState = compiled.bulkUpdateState.bind(compiled);
  compiled.bulkUpdateState = (...args) => {
    assert.equal(config.accessContext, "threads.update");
    return bulkUpdateState(...args);
  };
  return compiled;
};
