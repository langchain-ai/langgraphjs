import { describe, expect, it, vi } from "vitest";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { gatherIterator } from "../utils.js";
import {
  Annotation,
  Command,
  GraphCallbackHandler,
  type GraphInterruptEvent,
  type GraphResumeEvent,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "../index.js";

const State = Annotation.Root({ answer: Annotation<unknown>() });

class Recorder extends GraphCallbackHandler {
  interrupts: GraphInterruptEvent[] = [];
  resumes: GraphResumeEvent[] = [];
  order: string[] = [];
  runs = new Map<string, string | undefined>();

  handleChainStart(
    ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
  ) {
    this.runs.set(args[2], args[7]);
  }

  handleInterrupt(event: GraphInterruptEvent) {
    this.interrupts.push(event);
    this.order.push(`interrupt:${event.runId}`);
  }

  handleResume(event: GraphResumeEvent) {
    this.resumes.push(event);
    this.order.push(`resume:${event.runId}`);
  }

  handleChainEnd(_output: unknown, runId: string) {
    this.order.push(`end:${runId}`);
  }
}

function buildGraph() {
  return new StateGraph(State)
    .addNode("ask", () => ({ answer: interrupt("approve?") }))
    .addEdge(START, "ask")
    .compile({ checkpointer: new MemorySaver() });
}

it("exports a callback handler compatible with the core callback manager", () => {
  const handler = new Recorder();
  const manager = new CallbackManager();
  manager.addHandler(handler);
  expect(GraphCallbackHandler.isInstance(manager.handlers[0])).toBe(true);
  expect(
    GraphCallbackHandler.isInstance(BaseCallbackHandler.fromMethods({}))
  ).toBe(false);
});

describe("graph lifecycle callbacks", () => {
  it("reports a dynamic interrupt before chain end and resumes from its checkpoint", async () => {
    const handler = new Recorder();
    const graph = buildGraph();
    const config = {
      configurable: { thread_id: "dynamic" },
      callbacks: [handler],
    };
    const interruptRun = "00000000-0000-4000-8000-000000000001";
    const resumeRun = "00000000-0000-4000-8000-000000000002";
    const output = await graph.invoke(
      { answer: null },
      { ...config, runId: interruptRun }
    );
    const snapshot = await graph.getState(config);

    expect(handler.interrupts).toEqual([
      {
        runId: interruptRun,
        status: "pending",
        checkpointId: snapshot.config?.configurable?.checkpoint_id,
        checkpointNs: [],
        interrupts: (output as { __interrupt__?: unknown }).__interrupt__,
      },
    ]);
    expect(handler.interrupts[0].interrupts).toEqual([
      { id: expect.any(String), value: "approve?" },
    ]);
    expect(handler.order.indexOf(`interrupt:${interruptRun}`)).toBeLessThan(
      handler.order.indexOf(`end:${interruptRun}`)
    );
    expect(handler.resumes).toEqual([]);

    await expect(
      graph.invoke(new Command({ resume: "yes" }), {
        ...config,
        runId: resumeRun,
      })
    ).resolves.toEqual({ answer: "yes" });
    expect(handler.resumes).toEqual([
      {
        runId: resumeRun,
        status: "pending",
        checkpointId: snapshot.config?.configurable?.checkpoint_id,
        checkpointNs: [],
      },
    ]);
    expect(handler.interrupts).toHaveLength(1);
  });
});

it.each(["interruptBefore", "interruptAfter"] as const)(
  "reports %s with no interrupt payloads and resumes with null input",
  async (option) => {
    const handler = new Recorder();
    const graph = new StateGraph(State)
      .addNode("first", () => ({ answer: "first" }))
      .addNode("second", () => ({ answer: "second" }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .compile({ checkpointer: new MemorySaver(), [option]: ["first"] });
    const config = {
      configurable: { thread_id: option },
      callbacks: [handler],
    };
    await graph.invoke({ answer: null }, config);
    const snapshot = await graph.getState(config);
    expect(handler.interrupts).toEqual([
      {
        runId: expect.any(String),
        status:
          option === "interruptBefore" ? "interrupt_before" : "interrupt_after",
        checkpointId: snapshot.config?.configurable?.checkpoint_id,
        checkpointNs: [],
        interrupts: [],
      },
    ]);
    await expect(graph.invoke(null, config)).resolves.toEqual({
      answer: "second",
    });
    expect(handler.resumes).toHaveLength(1);
    expect(handler.resumes[0].checkpointId).toBe(
      handler.interrupts[0].checkpointId
    );
    expect(handler.interrupts).toHaveLength(1);
  }
);

it.each(["values", "updates", "messages", "custom"] as const)(
  "reports transitions independently of the %s stream mode",
  async (streamMode) => {
    const handler = new Recorder();
    const graph = buildGraph();
    const config = {
      configurable: { thread_id: streamMode },
      callbacks: [handler],
      streamMode,
    };
    const chunks = await gatherIterator(
      await graph.stream({ answer: null }, config)
    );
    expect(handler.interrupts).toHaveLength(1);
    if (streamMode === "custom" || streamMode === "messages")
      expect(chunks).toEqual([]);
    await gatherIterator(
      await graph.stream(new Command({ resume: "yes" }), config)
    );
    expect(handler.resumes).toHaveLength(1);
    expect(handler.interrupts).toHaveLength(1);
  }
);

it("preserves configured callbacks through compiled graph extraction, copies, and streamEvents", async () => {
  const configured = new Recorder();
  const invoked = new Recorder();
  const exported = {
    graph: buildGraph().withConfig({ callbacks: [configured] }),
  };
  const graph = exported.graph.withConfig({ tags: ["copy"] });
  const config = {
    configurable: { thread_id: "events" },
    callbacks: [invoked],
    version: "v2" as const,
    streamMode: "custom" as const,
  };
  const events = await gatherIterator(
    graph.streamEvents({ answer: null }, config)
  );
  const rootEnd = events.find(
    (event) => event.event === "on_chain_end" && event.name === "LangGraph"
  );
  expect(rootEnd).toBeDefined();
  expect(configured.interrupts).toHaveLength(1);
  expect(invoked.interrupts).toEqual(configured.interrupts);
  expect(configured.interrupts[0].runId).toBe(rootEnd?.run_id);
  await gatherIterator(
    graph.streamEvents(new Command({ resume: "yes" }), config)
  );
  expect(configured.resumes).toHaveLength(1);
  expect(invoked.resumes).toEqual(configured.resumes);
});

it.each([false, true])(
  "accepts a mixed callback manager (configured: %s)",
  async (configured) => {
    const handler = new Recorder();
    const ordinaryEnd = vi.fn();
    class Ordinary extends BaseCallbackHandler {
      name = "ordinary";
      handleInterrupt = vi.fn();
      handleResume = vi.fn();
      handleChainEnd = ordinaryEnd;
    }
    const ordinary = new Ordinary();
    const manager = new CallbackManager();
    manager.addHandler(handler, true);
    manager.addHandler(ordinary, true);
    const graph = configured
      ? buildGraph().withConfig({ callbacks: manager })
      : buildGraph();
    const config = {
      configurable: { thread_id: "manager" },
      ...(configured ? {} : { callbacks: manager }),
    };
    await graph.invoke({ answer: null }, config);
    await graph.invoke(new Command({ resume: "yes" }), config);
    expect(handler.interrupts).toHaveLength(1);
    expect(handler.resumes).toHaveLength(1);
    expect(ordinaryEnd).toHaveBeenCalled();
    expect(ordinary.handleInterrupt).not.toHaveBeenCalled();
    expect(ordinary.handleResume).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  "matches root interrupt and nested resume semantics (inherit: %s)",
  async (inherit) => {
    const handler = new Recorder();
    const manager = new CallbackManager();
    manager.addHandler(handler, inherit);
    const child = new StateGraph(State)
      .addNode("ask", () => ({ answer: interrupt("nested?") }))
      .addEdge(START, "ask")
      .compile({ name: "child" });
    const graph = new StateGraph(State)
      .addNode("child", child)
      .addEdge(START, "child")
      .compile({ checkpointer: new MemorySaver(), name: "parent" });
    const config = {
      configurable: { thread_id: "nested" },
      callbacks: manager,
    };
    await graph.invoke({ answer: null }, config);
    expect(handler.interrupts).toHaveLength(1);
    expect(handler.interrupts[0].checkpointNs).toEqual([]);
    expect(handler.runs.get(handler.interrupts[0].runId!)).toBe("parent");
    const rootCheckpoint = handler.interrupts[0].checkpointId;
    await expect(
      graph.invoke(new Command({ resume: "yes" }), config)
    ).resolves.toEqual({ answer: "yes" });
    expect(handler.interrupts).toHaveLength(1);
    expect(handler.resumes).toHaveLength(inherit ? 2 : 1);
    expect(handler.resumes[0]).toMatchObject({
      checkpointId: rootCheckpoint,
      checkpointNs: [],
      status: "pending",
    });
    expect(handler.runs.get(handler.resumes[0].runId!)).toBe("parent");
    if (inherit) {
      expect(handler.resumes[1].checkpointNs).toEqual([
        expect.stringMatching(/^child:/),
      ]);
      expect(handler.resumes[1].checkpointId).not.toBe(rootCheckpoint);
      expect(handler.resumes[1].runId).not.toBe(handler.resumes[0].runId);
      expect(handler.runs.get(handler.resumes[1].runId!)).toBe("child");
    }
  }
);

it.each([false, true])(
  "emits no lifecycle events on ordinary execution (failure: %s)",
  async (failure) => {
    const handler = new Recorder();
    const graph = new StateGraph(State)
      .addNode("node", () => {
        if (failure) throw new Error("node failure");
        return { answer: "done" };
      })
      .addEdge(START, "node")
      .compile();
    const result = graph.invoke({ answer: null }, { callbacks: [handler] });
    if (failure) await expect(result).rejects.toThrow("node failure");
    else await expect(result).resolves.toEqual({ answer: "done" });
    expect(handler.interrupts).toEqual([]);
    expect(handler.resumes).toEqual([]);
  }
);

it("awaits lifecycle handlers before chain end and before resumed node execution", async () => {
  let interrupted = false;
  let resumed = false;
  const endFlags: boolean[] = [];
  class AsyncObserver extends GraphCallbackHandler {
    awaitHandlers = false;
    async handleInterrupt() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      interrupted = true;
    }
    async handleResume() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      resumed = true;
    }
    handleChainEnd(_output: unknown, _runId: string, parentRunId?: string) {
      if (parentRunId === undefined) endFlags.push(interrupted);
    }
  }
  const graph = new StateGraph(State)
    .addNode("node", () => {
      const answer = interrupt("ready?");
      expect(resumed).toBe(true);
      return { answer };
    })
    .addEdge(START, "node")
    .compile({ checkpointer: new MemorySaver() });
  const config = {
    configurable: { thread_id: "async" },
    callbacks: [new AsyncObserver()],
  };
  await graph.invoke({ answer: null }, config);
  expect(endFlags).toEqual([true]);
  await graph.invoke(new Command({ resume: "yes" }), config);
  expect(resumed).toBe(true);
});

it.each(["interrupt", "resume"] as const)(
  "honors raiseError for %s callback failures",
  async (transition) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const raiseError of [false, true]) {
        for (const asynchronous of [false, true]) {
          const failure = new Error(`${transition} observer failure`);
          const rootErrors: unknown[] = [];
          class Failing extends GraphCallbackHandler {
            handleInterrupt() {
              if (transition === "interrupt") return this.fail();
            }
            handleResume() {
              if (transition === "resume") return this.fail();
            }
            fail(): void | Promise<void> {
              if (asynchronous) return Promise.reject(failure);
              throw failure;
            }
            handleChainError(
              error: unknown,
              _runId: string,
              parentRunId?: string
            ) {
              if (parentRunId === undefined) rootErrors.push(error);
            }
          }
          const graph = buildGraph();
          const config = {
            configurable: { thread_id: "failure" },
            callbacks: [new Failing({ raiseError })],
          };
          if (transition === "resume")
            await graph.invoke({ answer: null }, config);
          const result = graph.invoke(
            transition === "resume"
              ? new Command({ resume: "yes" })
              : { answer: null },
            config
          );
          if (raiseError) {
            await expect(result).rejects.toBe(failure);
            expect(rootErrors).toEqual([failure]);
          } else {
            await expect(result).resolves.toBeDefined();
            expect(rootErrors).toEqual([]);
          }
        }
      }
      expect(warning).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
      errorLog.mockRestore();
    }
  }
);

it.each([false, true])(
  "captures all parallel interrupts once at the root (nested: %s)",
  async (nested) => {
    const handler = new Recorder();
    const builder = new StateGraph(State)
      .addNode("left", () => {
        interrupt("left");
        return {};
      })
      .addNode("right", () => {
        interrupt("right");
        return {};
      })
      .addEdge(START, "left")
      .addEdge(START, "right");
    const graph = nested
      ? new StateGraph(State)
          .addNode("parallel", builder.compile())
          .addEdge(START, "parallel")
          .compile({ checkpointer: new MemorySaver() })
      : builder.compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "parallel" },
      callbacks: [handler],
    };
    await graph.invoke({ answer: null }, config);
    expect(handler.interrupts).toHaveLength(1);
    expect(
      handler.interrupts[0].interrupts.map(({ value }) => value).sort()
    ).toEqual(["left", "right"]);
    const resume = Object.fromEntries(
      handler.interrupts[0].interrupts.map(({ id }) => [id!, "yes"])
    );
    await graph.invoke(
      new Command<unknown, typeof State.Update, never>({ resume }),
      config
    );
    expect(handler.resumes).toHaveLength(nested ? 2 : 1);
    expect(handler.interrupts).toHaveLength(1);
  }
);

it.each(["interrupt", "resume"] as const)(
  "propagates %s callback errors through streamEvents",
  async (transition) => {
    const failure = new Error("observer failed");
    class Observer extends GraphCallbackHandler {
      raiseError = true;
      async handleInterrupt() {
        if (transition === "interrupt") throw failure;
      }
      async handleResume() {
        if (transition === "resume") throw failure;
      }
    }
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const graph = buildGraph().withConfig({ callbacks: [new Observer()] });
      const config = {
        configurable: { thread_id: "event failure" },
        version: "v2" as const,
      };
      if (transition === "resume")
        await gatherIterator(graph.streamEvents({ answer: null }, config));
      await expect(
        gatherIterator(
          graph.streamEvents(
            transition === "resume"
              ? new Command({ resume: "yes" })
              : { answer: null },
            config
          )
        )
      ).rejects.toBe(failure);
    } finally {
      errorLog.mockRestore();
    }
  }
);

it("awaits interrupt observers before emitting the root streamEvents end event", async () => {
  let notified = false;
  class Observer extends GraphCallbackHandler {
    awaitHandlers = false;
    async handleInterrupt() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      notified = true;
    }
  }
  const graph = buildGraph().withConfig({ callbacks: [new Observer()] });
  let ended = false;
  for await (const event of graph.streamEvents(
    { answer: null },
    { configurable: { thread_id: "event ordering" }, version: "v2" }
  )) {
    if (event.event === "on_chain_end" && event.name === "LangGraph") {
      expect(notified).toBe(true);
      ended = true;
    }
  }
  expect(ended).toBe(true);
});

it("does not require a checkpointer to report a static interrupt", async () => {
  const handler = new Recorder();
  const graph = new StateGraph(State)
    .addNode("ask", () => ({ answer: "done" }))
    .addEdge(START, "ask")
    .compile({ interruptBefore: ["ask"] });
  await graph.invoke({ answer: null }, { callbacks: [handler] });
  expect(handler.interrupts).toEqual([
    {
      runId: expect.any(String),
      status: "interrupt_before",
      checkpointId: expect.any(String),
      checkpointNs: [],
      interrupts: [],
    },
  ]);
});

it("does not report a resume for new input on an existing thread", async () => {
  const handler = new Recorder();
  const graph = new StateGraph(State)
    .addNode("node", (state) => state)
    .addEdge(START, "node")
    .compile({ checkpointer: new MemorySaver() });
  const config = {
    configurable: { thread_id: "new-input" },
    callbacks: [handler],
  };
  await graph.invoke({ answer: "first" }, config);
  await graph.invoke({ answer: "second" }, config);
  expect(handler.interrupts).toEqual([]);
  expect(handler.resumes).toEqual([]);
});
