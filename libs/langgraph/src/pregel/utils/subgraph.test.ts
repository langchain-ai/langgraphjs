import { describe, expect, it, jest } from "@jest/globals";
import { Runnable, RunnableSequence } from "@langchain/core/runnables";
import { isPregelLike, findSubgraphPregel } from "./subgraph.js";

describe("isPregelLike", () => {
  it("should return true for objects with lg_is_pregel=true", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      someOtherProp: "value"
    };
    
    expect(isPregelLike(mockPregelObj)).toBe(true);
  });
  
  it("should return false for objects without lg_is_pregel property", () => {
    const nonPregelObj = {
      someOtherProp: "value"
    };
    
    expect(isPregelLike(nonPregelObj)).toBe(false);
  });
  
  it("should return false for objects with lg_is_pregel=false", () => {
    const nonPregelObj = {
      lg_is_pregel: false,
      someOtherProp: "value"
    };
    
    expect(isPregelLike(nonPregelObj)).toBe(false);
  });
});

describe("findSubgraphPregel", () => {
  it("should find Pregel object at the top level", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      someOtherProp: "value"
    };
    
    expect(findSubgraphPregel(mockPregelObj as unknown as Runnable)).toBe(mockPregelObj);
  });
  
  it("should find Pregel object in a RunnableSequence", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      someOtherProp: "value"
    };
    
    const mockSequence = {
      steps: [
        { someProperty: "value" },
        mockPregelObj
      ]
    };
    
    expect(findSubgraphPregel(mockSequence as unknown as Runnable)).toBe(mockPregelObj);
  });
  
  it("should find Pregel object in a nested RunnableSequence", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      someOtherProp: "value"
    };
    
    const innerSequence = {
      steps: [
        { someProperty: "value" },
        mockPregelObj
      ]
    };
    
    const outerSequence = {
      steps: [
        { someProperty: "otherValue" },
        innerSequence
      ]
    };
    
    expect(findSubgraphPregel(outerSequence as unknown as Runnable)).toBe(mockPregelObj);
  });
  
  it("should return undefined if no Pregel object is found", () => {
    const nonPregelRunnable = {
      someProperty: "value",
      invoke: () => {}
    };
    
    const sequence = {
      steps: [
        { someProperty: "value1" },
        { someProperty: "value2" }
      ]
    };
    
    expect(findSubgraphPregel(nonPregelRunnable as unknown as Runnable)).toBeUndefined();
    expect(findSubgraphPregel(sequence as unknown as Runnable)).toBeUndefined();
  });
});