import { describe, expect, it } from "vitest";
import { Runnable } from "@langchain/core/runnables";
import { isPregelLike, findSubgraphPregel } from "./subgraph.js";

describe("isPregelLike", () => {
  it("should return true for objects with lg_is_pregel=true", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      invoke: () => {},
      someOtherProp: "value",
    };

    // Cast to any to test just the logic, not the type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isPregelLike(mockPregelObj as any)).toBe(true);
  });

  it("should return false for objects without lg_is_pregel property", () => {
    const nonPregelObj = {
      invoke: () => {},
      someOtherProp: "value",
    };

    // Cast to any to test just the logic, not the type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isPregelLike(nonPregelObj as any)).toBe(false);
  });

  it("should return false for objects with lg_is_pregel=false", () => {
    const nonPregelObj = {
      lg_is_pregel: false,
      invoke: () => {},
      someOtherProp: "value",
    };

    // Cast to any to test just the logic, not the type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isPregelLike(nonPregelObj as any)).toBe(false);
  });
});

describe("findSubgraphPregel", () => {
  it("should find Pregel object at the top level", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      invoke: () => {},
      someOtherProp: "value",
    };

    // Cast to Runnable to test the behavior
    expect(findSubgraphPregel(mockPregelObj as unknown as Runnable)).toBe(
      mockPregelObj
    );
  });

  it("should find Pregel object in a RunnableSequence", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      invoke: () => {},
      someOtherProp: "value",
    };

    const mockSequence = {
      steps: [{ someProperty: "value", invoke: () => {} }, mockPregelObj],
    };

    expect(findSubgraphPregel(mockSequence as unknown as Runnable)).toBe(
      mockPregelObj
    );
  });

  it("should find Pregel object in a nested RunnableSequence", () => {
    const mockPregelObj = {
      lg_is_pregel: true,
      invoke: () => {},
      someOtherProp: "value",
    };

    const innerSequence = {
      steps: [{ someProperty: "value", invoke: () => {} }, mockPregelObj],
    };

    const outerSequence = {
      steps: [{ someProperty: "otherValue", invoke: () => {} }, innerSequence],
    };

    expect(findSubgraphPregel(outerSequence as unknown as Runnable)).toBe(
      mockPregelObj
    );
  });

  it("should return undefined if no Pregel object is found", () => {
    const nonPregelRunnable = {
      someProperty: "value",
      invoke: () => {},
    };

    const sequence = {
      steps: [{ someProperty: "value1" }, { someProperty: "value2" }],
    };

    expect(
      findSubgraphPregel(nonPregelRunnable as unknown as Runnable)
    ).toBeUndefined();
    expect(findSubgraphPregel(sequence as unknown as Runnable)).toBeUndefined();
  });
});
