import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  Annotation,
  END,
  GraphDrained,
  LangGraphRunnableConfig,
  RunControl,
  START,
  StateGraph,
} from "../web.js";
import { task, entrypoint } from "../func/index.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

const State = Annotation.Root({
  first: Annotation<string>,
  second: Annotation<string>,
  value: Annotation<string>,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunControl", () => {
  it("requestDrain sets drainRequested/drainReason", () => {
    const control = new RunControl();
    expect(control.drainRequested).toBe(false);
    expect(control.drainReason).toBeUndefined();

    control.requestDrain();
    expect(control.drainRequested).toBe(true);
    expect(control.drainReason).toBe("shutdown");

    const other = new RunControl();
    other.requestDrain("sigterm");
    expect(other.drainReason).toBe("sigterm");
  });
});

describe("Graph draining", () => {
  it("drain requested in a node stops future steps (sync-style node)", async () => {
    const control = new RunControl();

    const graph = new StateGraph(State)
      .addNode("stepA", () => {
        control.requestDrain();
        return { first: "done" };
      })
      .addNode("stepB", () => ({ second: "should-not-run" }))
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    await expect(graph.invoke({}, { control })).rejects.toThrow(
      /Graph drained: shutdown/
    );
  });

  it("drain requested in a node stops future steps (async node)", async () => {
    const control = new RunControl();

    const graph = new StateGraph(State)
      .addNode("stepA", async () => {
        control.requestDrain();
        return { first: "done" };
      })
      .addNode("stepB", async () => ({ second: "should-not-run" }))
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    let captured: unknown;
    try {
      await graph.invoke({}, { control });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(GraphDrained);
    expect((captured as GraphDrained).reason).toBe("shutdown");
  });

  it("drain requested in the terminal step finishes normally", async () => {
    const control = new RunControl();

    const graph = new StateGraph(State)
      .addNode("only", () => {
        control.requestDrain();
        return { value: "done" };
      })
      .addEdge(START, "only")
      .addEdge("only", END)
      .compile();

    const result = await graph.invoke({}, { control });
    expect(result).toEqual({ value: "done" });
    expect(control.drainRequested).toBe(true);
  });

  it("a node can request drain via runtime.control", async () => {
    const control = new RunControl();
    let sawControl = false;

    const graph = new StateGraph(State)
      .addNode("stepA", (_state, runtime: LangGraphRunnableConfig) => {
        // Nodes receive the run control on their runtime/config.
        sawControl = runtime.control === control;
        runtime.control?.requestDrain("from-node");
        return { first: "done" };
      })
      .addNode("stepB", () => ({ second: "should-not-run" }))
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    await expect(graph.invoke({}, { control })).rejects.toThrow(
      /Graph drained: from-node/
    );
    expect(sawControl).toBe(true);
  });

  it("a fresh RunControl is provided to nodes when none is passed", async () => {
    let controlSeen: RunControl | undefined;

    const graph = new StateGraph(State)
      .addNode("only", (_state, runtime: LangGraphRunnableConfig) => {
        controlSeen = runtime.control;
        return { value: "done" };
      })
      .addEdge(START, "only")
      .addEdge("only", END)
      .compile();

    await graph.invoke({});
    expect(controlSeen).toBeInstanceOf(RunControl);
    expect(controlSeen!.drainRequested).toBe(false);
  });

  it("pre-drained control stops before executing the first task", async () => {
    let ran = false;
    const control = new RunControl();
    control.requestDrain("pre-drained");

    const graph = new StateGraph(State)
      .addNode("only", () => {
        ran = true;
        return { value: "done" };
      })
      .addEdge(START, "only")
      .addEdge("only", END)
      .compile();

    await expect(graph.invoke({}, { control })).rejects.toThrow(
      /Graph drained: pre-drained/
    );
    expect(ran).toBe(false);
  });

  it("drain persists a resumable checkpoint (exit durability)", async () => {
    const control = new RunControl();

    const graph = new StateGraph(State)
      .addNode("stepA", () => {
        control.requestDrain("sigterm");
        return { first: "done" };
      })
      .addNode("stepB", () => ({ second: "done" }))
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: "drain-exit" } };

    await expect(
      graph.invoke({}, { ...config, durability: "exit", control })
    ).rejects.toThrow(/Graph drained: sigterm/);

    // Resume without a control: the run finishes from the saved checkpoint.
    const resumed = await graph.invoke(null, { ...config, durability: "exit" });
    expect(resumed).toEqual({ first: "done", second: "done" });
  });

  it("drain persists a resumable checkpoint (default durability)", async () => {
    const control = new RunControl();

    const graph = new StateGraph(State)
      .addNode("stepA", () => {
        control.requestDrain("sigterm");
        return { first: "done" };
      })
      .addNode("stepB", () => ({ second: "done" }))
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: "drain-default" } };

    await expect(graph.invoke({}, { ...config, control })).rejects.toThrow(
      /Graph drained: sigterm/
    );

    const resumed = await graph.invoke(null, config);
    expect(resumed).toEqual({ first: "done", second: "done" });
  });

  it("drain from a subgraph bubbles up and the parent can resume", async () => {
    const control = new RunControl();

    const childBuilder = new StateGraph(State)
      .addNode("childFirst", () => {
        control.requestDrain("sigterm");
        return { first: "done" };
      })
      .addNode("childSecond", () => ({ second: "done" }))
      .addEdge(START, "childFirst")
      .addEdge("childFirst", "childSecond")
      .addEdge("childSecond", END);
    const childGraph = childBuilder.compile({ checkpointer: true });

    const parentBuilder = new StateGraph(State)
      .addNode("child", childGraph)
      .addNode("parentSecond", () => ({ value: "parent-done" }))
      .addEdge(START, "child")
      .addEdge("child", "parentSecond")
      .addEdge("parentSecond", END);
    const parentGraph = parentBuilder.compile({
      checkpointer: new MemorySaver(),
    });

    const config = { configurable: { thread_id: "drain-subgraph" } };

    await expect(parentGraph.invoke({}, { ...config, control })).rejects.toThrow(
      GraphDrained
    );

    const resumed = await parentGraph.invoke(null, config);
    expect(resumed).toEqual({
      first: "done",
      second: "done",
      value: "parent-done",
    });
  });

  it("an external concurrent drain stops the graph at the next boundary", async () => {
    const control = new RunControl();
    let started = false;
    let secondRan = false;

    const graph = new StateGraph(State)
      .addNode("stepA", async () => {
        started = true;
        await sleep(50);
        return { first: "done" };
      })
      .addNode("stepB", async () => {
        secondRan = true;
        return { second: "should-not-run" };
      })
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    const runPromise = graph.invoke({}, { control });

    // Wait until the first node is mid-flight, then request drain externally.
    while (!started) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(5);
    }
    control.requestDrain("sigterm");

    let captured: unknown;
    try {
      await runPromise;
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(GraphDrained);
    expect((captured as GraphDrained).reason).toBe("sigterm");
    expect(secondRan).toBe(false);
  });

  it("drain then cancel via AbortSignal after a graceful timeout", async () => {
    const control = new RunControl();
    const abortController = new AbortController();

    let nodeStarted = false;
    let nodeCancelled = false;
    let nodeFinished = false;
    let secondRan = false;

    const graph = new StateGraph(State)
      .addNode("stepA", async (_state, runtime: LangGraphRunnableConfig) => {
        nodeStarted = true;
        const { signal } = runtime;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            nodeFinished = true;
            resolve();
          }, 30_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              nodeCancelled = true;
              reject(new Error("Aborted"));
            },
            { once: true }
          );
        });
        return { first: "done" };
      })
      .addNode("stepB", async () => {
        secondRan = true;
        return { second: "should-not-run" };
      })
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    const runPromise = graph.invoke(
      {},
      { control, signal: abortController.signal }
    );
    // Surface the rejection lazily; attach a catch so it isn't unhandled.
    const settled = runPromise.then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );

    while (!nodeStarted) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(5);
    }
    // Drain is requested, but the long-running node hasn't yielded yet.
    control.requestDrain("sigterm");
    await sleep(50);
    expect(nodeFinished).toBe(false);
    expect(nodeCancelled).toBe(false);

    // Hard cancel after the graceful window.
    abortController.abort();

    const result = await settled;
    expect(result.ok).toBe(false);
    expect(nodeCancelled).toBe(true);
    expect(nodeFinished).toBe(false);
    expect(secondRan).toBe(false);
  });

  it("control is accepted by stream() and raises GraphDrained", async () => {
    const control = new RunControl();
    let secondRan = false;

    const graph = new StateGraph(State)
      .addNode("stepA", () => {
        control.requestDrain("sigterm");
        return { value: "done" };
      })
      .addNode("stepB", () => {
        secondRan = true;
        return { second: "nope" };
      })
      .addEdge(START, "stepA")
      .addEdge("stepA", "stepB")
      .addEdge("stepB", END)
      .compile();

    const drain = async () => {
      const stream = await graph.stream({}, { control });
      // eslint-disable-next-line no-empty, @typescript-eslint/no-unused-vars
      for await (const _ of stream) {
        // drain the stream
      }
    };

    await expect(drain()).rejects.toThrow(/Graph drained: sigterm/);
    expect(secondRan).toBe(false);
  });
});

describe("Functional API draining", () => {
  it("in-flight task futures still resolve after requestDrain()", async () => {
    const checkpointer = new MemorySaver();
    const control = new RunControl();

    const child = task("child", async (x: number) => x + 1);

    const graph = entrypoint(
      { checkpointer, name: "graph" },
      async (x: number) => {
        control.requestDrain();
        const fut = child(x);
        return fut;
      }
    );

    const result = await graph.invoke(1, {
      configurable: { thread_id: "drain-call" },
      control,
    });
    expect(result).toBe(2);
    expect(control.drainRequested).toBe(true);
  });
});
