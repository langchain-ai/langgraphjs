import { expect, it } from "vitest";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  Send,
  StateGraph,
} from "../../web.js";

it.each(["async", "sync", "exit"] as const)(
  "keeps completed subgraph writes after a sibling fails (%s)",
  async (durability) => {
    const charges: Record<string, number> = { A: 0, B: 0 };
    let fail = true;
    const Order = Annotation.Root({
      order: Annotation<string>({
        reducer: (_, order) => order,
        default: () => "",
      }),
    });
    const fulfil = new StateGraph(Order)
      .addNode("charge", async ({ order }) => {
        charges[order] += 1;
        return {};
      })
      .addNode("stock", async ({ order }) => {
        await new Promise((resolve) =>
          setTimeout(resolve, order === "A" ? 5 : 50)
        );
        if (order === "A" && fail) {
          fail = false;
          throw new Error("stock unavailable");
        }
        return {};
      })
      .addEdge(START, "charge")
      .addEdge(START, "stock")
      .addEdge("charge", END)
      .addEdge("stock", END)
      .compile();
    const app = new StateGraph(Order)
      .addNode("fulfil", fulfil)
      .addConditionalEdges(
        START,
        () => ["A", "B"].map((order) => new Send("fulfil", { order })),
        ["fulfil"]
      )
      .addEdge("fulfil", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "orders" }, durability };
    await expect(app.invoke({}, config)).rejects.toThrow("stock unavailable");
    await app.invoke(null, config);
    expect(charges).toEqual({ A: 1, B: 1 });
  }
);

it.each([1, 2])(
  "flushes cancelled child checkpoints with a slow saver (depth %s)",
  async (depth) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowSaver extends MemorySaver {
      override async put(...args: Parameters<MemorySaver["put"]>) {
        if (args[0].configurable?.checkpoint_ns) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return super.put(...args);
      }
    }
    let charges = 0;
    let first = true;
    const State = Annotation.Root({ value: Annotation<string> });
    const child = new StateGraph(State)
      .addNode("charge", () => {
        charges++;
        return {};
      })
      .addNode("hold", async () => {
        if (first) {
          first = false;
          started();
          await blocked;
        }
        return {};
      })
      .addEdge(START, "charge")
      .addEdge(START, "hold")
      .addEdge("charge", END)
      .addEdge("hold", END)
      .compile();
    const nested =
      depth === 1
        ? child
        : new StateGraph(State)
            .addNode("inner", child)
            .addEdge(START, "inner")
            .addEdge("inner", END)
            .compile();
    let fail = true;
    const graph = new StateGraph(State)
      .addNode("child", nested)
      .addNode("fail", async () => {
        if (fail) {
          fail = false;
          await ready;
          await new Promise<void>((resolve) => setImmediate(resolve));
          throw new Error("sibling failed");
        }
        return {};
      })
      .addEdge(START, "child")
      .addEdge(START, "fail")
      .addEdge("child", END)
      .addEdge("fail", END)
      .compile({ checkpointer: new SlowSaver() });
    const config = {
      configurable: { thread_id: "cancel" },
      durability: "exit" as const,
    };
    const controller = new AbortController();
    const run = graph.invoke(
      { value: "order" },
      { ...config, signal: controller.signal }
    );
    try {
      await expect(run).rejects.toThrow("sibling failed");
      await graph.invoke(null, config);
      expect(charges).toBe(1);
    } finally {
      release();
    }
  }
);
