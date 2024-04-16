import { describe, it, expect } from "@jest/globals";
import { StateGraph } from "../graph/state.js";

describe("State", () => {
  it("should validate a new node key correctly ", () => {
    const stateGraph = new StateGraph({
      channels: { existingStateAttributeKey: { value: null } },
    });
    expect(() => {
      stateGraph.addNode("existingStateAttributeKey", () => {});
    }).toThrow("existingStateAttributeKey");

    expect(() => {
      stateGraph.addNode("newNodeKey", () => {});
    }).not.toThrow();
  });
});
