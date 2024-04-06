import { describe, expect, it } from "@jest/globals";
import { GraphBuilder, StateGraphBuilder } from "../graph/builder.js";
import { END } from "../graph/graph.js";

describe("GraphBuilder", () => {
  it("can't `.addEdge` between nodes that haven't been declared yet", () => {
    expect(() => {
      new GraphBuilder()
        .addNode("a", () => {})
        .addNode("b", () => {})
        // This is fine
        .addEdge("a", "b")
        // @ts-expect-error - this must type-error
        .addEdge("b", "c");
    }).toThrow();
  });

  describe(".addConditionalEdge", () => {
    const builder = () =>
      new GraphBuilder().addNode("a", () => {}).addNode("b", () => {});

    // This is fine
    builder().addConditionalEdges("a", () => "next", { next: "b" });

    it("node mappings must point to existing nodes", () => {
      expect(() => {
        builder().addConditionalEdges("b", () => "next", {
          next: "b",
          // @ts-expect-error - this must type-error
          missing: "missing",
        });
      }).toThrow();
    });

    it("condition return key must exists when no mapping is provided", () => {
      // @ts-expect-error - this must type-error
      builder().addConditionalEdges("b", () => "missing");
    });

    it("start node must exist", () => {
      expect(() => {
        // @ts-expect-error - this must type-error
        builder().addConditionalEdges("missing", () => "next", { next: "b" });
      }).toThrow();
    });

    it("condition return key must exists in node mapping", () => {
      // @ts-expect-error - this must type-error
      builder().addConditionalEdges("b", () => "next", { continue: "b" });
    });

    it("adding and end to END is always fine, regardless of added nodes", () => {
      // This is fine
      builder().addEdge("a", END);
    });

    it("condition return key must exists in node mapping - async", () => {
      // TODO: When return is a promise, we don't get a type-error unless we
      // explicitly `as const` the return value or provide an explicit return
      // type

      // TODO: This should be a type-error but it is not
      builder().addConditionalEdges("b", async () => "next", { continue: "b" });

      builder().addConditionalEdges("b", async () => "next" as const, {
        // @ts-expect-error - this must type-error
        continue: "b",
      });

      builder().addConditionalEdges("b", async (): Promise<"next"> => "next", {
        // @ts-expect-error - this must type-error
        continue: "b",
      });
    });
  });

  it("forking builders works at runtime but should type-error", () => {
    const builder1 = new GraphBuilder().addNode("a", () => {});
    const builder2 = new GraphBuilder().addNode("b", () => {});

    expect(() => {
      // @ts-expect-error - this must type-error
      builder1.addEdge("a", "b");
    }).toThrow();

    expect(() => {
      // @ts-expect-error - this must type-error
      builder2.addEdge("a", "b");
    }).toThrow();
  });

  it("must complete builder before compiling", () => {
    const builder = new GraphBuilder()
      .addNode("a", () => {})
      .addNode("b", () => {})
      .addEdge("a", "b")
      .setEntryPoint("a")
      .setFinishPoint("b");

    // This is fine
    builder.done().compile();

    // @ts-expect-error - this must type-error
    builder.compile().invoke({});
  });
});

describe("StateGraphBuilder", () => {
  const channels = () => ({ channels: {} });

  it("can't `.addEdge` between nodes that haven't been declared yet", () => {
    expect(() => {
      new StateGraphBuilder(channels())
        .addNode("a", () => {})
        .addNode("b", () => {})
        // This is fine
        .addEdge("a", "b")
        // @ts-expect-error - this must type-error
        .addEdge("b", "c");
    }).toThrow();
  });

  describe(".addConditionalEdge", () => {
    const builder = () =>
      new StateGraphBuilder(channels())
        .addNode("a", () => {})
        .addNode("b", () => {});

    // This is fine
    builder().addConditionalEdges("a", () => "next", { next: "b" });

    it("node mappings must point to existing nodes", () => {
      expect(() => {
        builder().addConditionalEdges("b", () => "next", {
          next: "b",
          // @ts-expect-error - this must type-error
          missing: "missing",
        });
      }).toThrow();
    });

    it("start node must exist", () => {
      expect(() => {
        // @ts-expect-error - this must type-error
        builder().addConditionalEdges("missing", () => "next", { next: "b" });
      }).toThrow();
    });

    it("condition return key must exists in node mapping", () => {
      // @ts-expect-error - this must type-error
      builder().addConditionalEdges("b", () => "next", { continue: "b" });
    });

    it("condition return key must exists when no mapping is provided", () => {
      // @ts-expect-error - this must type-error
      builder().addConditionalEdges("b", () => "missing");
    });

    it("adding and end to END is always fine, regardless of added nodes", () => {
      // This is fine
      builder().addEdge("a", END);
    });

    it("condition return key must exists in node mapping - async", () => {
      // TODO: When return is a promise, we don't get a type-error unless we
      // explicitly `as const` the return value or provide an explicit return
      // type

      // TODO: This should be a type-error but it is not
      builder().addConditionalEdges("b", async () => "next", { continue: "b" });

      builder().addConditionalEdges("b", async () => "next" as const, {
        // @ts-expect-error - this must type-error
        continue: "b",
      });

      builder().addConditionalEdges("b", async (): Promise<"next"> => "next", {
        // @ts-expect-error - this must type-error
        continue: "b",
      });
    });
  });

  it("forking builders works at runtime but should type-error", () => {
    const builder1 = new StateGraphBuilder(channels()).addNode("a", () => {});
    const builder2 = new StateGraphBuilder(channels()).addNode("b", () => {});

    expect(() => {
      // @ts-expect-error - this must type-error
      builder1.addEdge("a", "b");
    }).toThrow();

    expect(() => {
      // @ts-expect-error - this must type-error
      builder2.addEdge("a", "b");
    }).toThrow();
  });

  it("must complete builder before compiling", () => {
    const builder = new StateGraphBuilder(channels())
      .addNode("a", () => ({}))
      .addNode("b", () => ({}))
      .addEdge("a", "b")
      .setEntryPoint("a")
      .setFinishPoint("b");

    // This is fine
    builder.done().compile();

    // @ts-expect-error - this must type-error
    builder.compile().invoke({});
  });
});
