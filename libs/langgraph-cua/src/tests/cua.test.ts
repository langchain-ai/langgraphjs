import { test, expect } from "vitest";
import { Annotation } from "@langchain/langgraph";
import { CUAState, CUAUpdate } from "../types.js";
import { createCua } from "../index.js";

test("Can extend the state with a custom annotation", () => {
  const CustomAnnotation = Annotation.Root({
    foo: Annotation<string>,
  });

  type CustomState = CUAState & typeof CustomAnnotation.State;
  type CustomStateUpdate = CUAUpdate & typeof CustomAnnotation.Update;

  const beforeNode = async (
    _state: CustomState
  ): Promise<CustomStateUpdate> => {
    return {};
  };

  const afterNode = async (_state: CustomState): Promise<CustomStateUpdate> => {
    return {};
  };

  // Ensure this does not throw a type error
  const graph = createCua({
    stateModifier: CustomAnnotation,
    nodeBeforeAction: beforeNode,
    nodeAfterAction: afterNode,
  });

  expect(graph).toBeDefined();
});
