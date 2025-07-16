import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import {
  Annotation,
  Command,
  END,
  LangGraphRunnableConfig,
  MemorySaver,
  START,
  StateGraph,
} from "../../web.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";

type TestMode =
  | "Single layer graph"
  | "Subgraph called within node without config"
  | "Subgraph called within node with config"
  | "Subgraph called as node";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

describe("Pregel AbortSignal", () => {
  let checkpointer: MemorySaver = new MemorySaver();
  let oneCount = 0;
  let oneResolved = false;
  let oneRejected = false;
  let twoCount = 0;
  let twoResolved = false;
  let twoRejected = false;

  beforeEach(() => {
    oneCount = 0;
    oneResolved = false;
    oneRejected = false;
    twoCount = 0;
    twoResolved = false;
    twoRejected = false;
    checkpointer = new MemorySaver();
  });

  const StateAnnotation = Annotation.Root({
    nodeLog: Annotation<Record<string, Set<string>>>({
      value: (a, b) => {
        const result: Record<string, Set<string>> = Object.fromEntries(
          Object.entries(a).filter(([invokeId]) => !(invokeId in b))
        );

        for (const [invokeId, log] of Object.entries(b)) {
          const existing = a[invokeId] ?? new Set<string>();
          // eslint-disable-next-line no-param-reassign
          result[invokeId] = new Set([...existing, ...log]);
        }

        return result;
      },
      default: () => ({}),
    }),
    shouldThrow: Annotation<boolean>({
      value: (a, b) => b ?? a,
      default: () => true,
    }),
  });

  function getKey(config: LangGraphRunnableConfig) {
    return config.configurable?.invokeId ?? "undefined";
  }

  function createGraph({
    mode,
    checkSignal,
  }: {
    mode: TestMode;
    checkSignal: boolean;
  }) {
    const graph = new StateGraph(StateAnnotation)
      .addNode("one", async (_, config) => {
        const key = getKey(config);

        oneCount += 1;

        if (checkSignal) {
          const { signal } = config;
          expect(signal).toBeDefined();
          return new Promise((resolve, reject) => {
            const listener = () => {
              oneRejected = true;
              reject(new Error("Aborted"));
            };

            signal!.addEventListener("abort", listener, { once: true });
            setTimeout(() => {
              if (!signal!.aborted) {
                signal!.removeEventListener("abort", listener);
                oneResolved = true;

                resolve({ nodeLog: { [key]: new Set(["one"]) } });
              }
            }, 50);
          });
        }

        await new Promise((resolve) => {
          oneResolved = true;
          setTimeout(resolve, 50);
        });

        return { nodeLog: { [key]: new Set(["one"]) } };
      })
      .addNode("two", (state, config) => {
        const key = getKey(config);

        twoCount += 1;
        if (state.shouldThrow) {
          twoRejected = true;
          throw new Error("Should not be called!");
        }

        twoResolved = true;
        return { nodeLog: { [key]: new Set(["two"]) } };
      })
      .addEdge(START, "one")
      .addEdge("one", "two")
      .addEdge("two", END)
      .compile({ checkpointer });

    if (mode === "Single layer graph") {
      return graph;
    }

    if (mode === "Subgraph called within node without config") {
      return new StateGraph(StateAnnotation)
        .addNode("graph", async ({ shouldThrow }, config) => {
          const key = getKey(config);

          // IMPORTANT: We're explicitly not passing the config here.
          const result = await graph.invoke({ shouldThrow });
          // returning two update commands here to make the reducer do the "heavy lifting" of
          // combining the subgraph result with the parent graph result.

          return [
            new Command({ update: { nodeLog: { [key]: new Set(["graph"]) } } }),
            new Command({ update: result }),
          ];
        })
        .addEdge(START, "graph")
        .addEdge("graph", END)
        .compile({ checkpointer });
    }

    if (mode === "Subgraph called within node with config") {
      return new StateGraph(StateAnnotation)
        .addNode("graph", async ({ shouldThrow }, config) => {
          const key = getKey(config);

          // IMPORTANT: We're explicitly passing the config here, as that's the point of this test case
          const result = await graph.invoke({ shouldThrow }, config);
          // returning two update commands here to make the reducer do the "heavy lifting" of
          // combining the subgraph result with the parent graph result.
          return [
            new Command({ update: { nodeLog: { [key]: new Set(["graph"]) } } }),
            new Command({ update: result }),
          ];
        })
        .addEdge(START, "graph")
        .addEdge("graph", END)
        .compile({ checkpointer });
    }

    if (mode === "Subgraph called as node") {
      return new StateGraph(StateAnnotation)
        .addNode("graph", graph)
        .addEdge(START, "graph")
        .addEdge("graph", END)
        .compile({ checkpointer });
    }

    throw new Error(`Unknown mode: ${mode}`);
  }

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should cancel when external AbortSignal is aborted",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
        configurable: { thread_id: uuidv4() },
      };

      setTimeout(() => abortController.abort(), 10);

      await expect(() =>
        createGraph({ mode, checkSignal: false }).invoke({}, config)
      ).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should cancel when step timeout is triggered",
    async (mode) => {
      const graph = createGraph({ mode, checkSignal: false });
      graph.stepTimeout = 10;

      await expect(() =>
        graph.invoke({}, { configurable: { thread_id: uuidv4() } })
      ).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should cancel when external AbortSignal is aborted while step timeout is set",
    async (mode) => {
      const graph = createGraph({ mode, checkSignal: false });
      graph.stepTimeout = 100;

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 10);

      const config = {
        configurable: { thread_id: uuidv4() },
        signal: abortController.signal,
      };

      await expect(() => graph.invoke({}, config)).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should pass AbortSignal into nodes via config when timeout is provided but no external signal is given",
    async (mode) => {
      const config = { timeout: 10, configurable: { thread_id: uuidv4() } };

      await expect(() => {
        const graph = createGraph({ mode, checkSignal: true });
        graph.stepTimeout = 10;
        return graph.invoke({}, config);
      }).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(oneResolved).toEqual(false);
      expect(oneRejected).toEqual(true);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should trigger AbortSignal that is passed to node on timeout when both signal and timeout are set on invocation",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
        timeout: 10,
        configurable: { thread_id: uuidv4() },
      };

      await expect(() =>
        createGraph({ mode, checkSignal: true }).invoke({}, config)
      ).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(oneResolved).toEqual(false);
      expect(oneRejected).toEqual(true);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "Single layer graph",
    "Subgraph called within node without config",
    "Subgraph called within node with config",
    "Subgraph called as node",
  ] as TestMode[])(
    "%s should trigger AbortSignal that is passed to node when external signal triggered when both signal and timeout are set on invocation",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
        timeout: 100,
        configurable: {
          thread_id: uuidv4(),
        },
      };

      setTimeout(() => abortController.abort(), 10);

      await expect(() =>
        createGraph({ mode, checkSignal: true }).invoke({}, config)
      ).rejects.toThrow("Abort");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(oneResolved).toEqual(false);
      expect(oneRejected).toEqual(true);
      expect(twoCount).toEqual(0);
    }
  );

  it.each(
    [
      "Single layer graph",
      "Subgraph called within node without config",
      "Subgraph called within node with config",
      "Subgraph called as node",
    ].flatMap((mode) =>
      ["exception", "timeout", "external abort"].map((abortCause) => [
        mode,
        abortCause,
      ])
    ) as [TestMode, "exception" | "timeout" | "external abort"][]
  )(
    "%s should resume from last successful invocation when AbortSignal is aborted due to %s",
    async (mode, abortCause) => {
      const graph = createGraph({ mode, checkSignal: true });

      const thread1Id = uuidv4();
      const thread2Id = uuidv4();

      const thread1Execution1Result = await graph.invoke(
        { shouldThrow: false },
        { configurable: { thread_id: thread1Id, invokeId: "1" } }
      );

      expect(oneCount).toEqual(1);
      expect(twoCount).toEqual(1);

      expect(oneRejected).toEqual(false);
      expect(oneResolved).toEqual(true);
      expect(twoRejected).toEqual(false);
      expect(twoResolved).toEqual(true);

      oneResolved = false;
      oneRejected = false;
      twoResolved = false;
      twoRejected = false;

      const thread1Execution2Result = await graph.invoke(
        { shouldThrow: false },
        { configurable: { thread_id: thread1Id, invokeId: "2" } }
      );

      expect(oneCount).toEqual(2);
      expect(twoCount).toEqual(2);
      expect(oneRejected).toEqual(false);
      expect(oneResolved).toEqual(true);
      expect(twoRejected).toEqual(false);
      expect(twoResolved).toEqual(true);

      oneResolved = false;
      oneRejected = false;
      twoResolved = false;
      twoRejected = false;

      const thread2Execution1Result = await graph.invoke(
        { shouldThrow: false },
        { configurable: { thread_id: thread2Id, invokeId: "1" } }
      );

      expect(oneCount).toEqual(3);
      expect(twoCount).toEqual(3);
      expect(oneRejected).toEqual(false);
      expect(oneResolved).toEqual(true);
      expect(twoRejected).toEqual(false);
      expect(twoResolved).toEqual(true);

      oneResolved = false;
      oneRejected = false;
      twoResolved = false;
      twoRejected = false;

      const abortController = new AbortController();

      if (abortCause === "external abort") {
        setTimeout(() => abortController.abort(), 10);
      }

      await expect(
        graph.invoke(
          { shouldThrow: true }, // triggers default case, abortCause === "exception"
          {
            configurable: { thread_id: thread2Id, invokeId: "2" },
            signal: abortController.signal,
            ...(abortCause === "timeout" && { timeout: 10 }),
          }
        )
      ).rejects.toThrow(
        abortCause === "exception" ? "Should not be called!" : "Abort"
      );

      expect(oneCount).toEqual(4);
      expect(twoCount).toEqual(abortCause === "exception" ? 4 : 3);
      expect(oneRejected).toEqual(abortCause !== "exception");
      expect(oneResolved).toEqual(abortCause === "exception");

      // two never runs unless abortCause === "exception", so it's false, false for all other cases
      expect(twoRejected).toEqual(abortCause === "exception");
      expect(twoResolved).toEqual(false);

      oneResolved = false;
      oneRejected = false;
      twoResolved = false;
      twoRejected = false;

      const thread2Execution2Attempt1Result = (
        await graph.getState({
          configurable: { thread_id: thread2Id },
        })
      ).values as typeof StateAnnotation.State;

      const thread2Execution2Attempt2Result = await graph.invoke(
        { shouldThrow: false },
        { configurable: { thread_id: thread2Id, invokeId: "2" } }
      );

      expect(oneCount).toEqual(5);
      expect(twoCount).toEqual(abortCause === "exception" ? 5 : 4);
      expect(oneRejected).toEqual(false);
      expect(oneResolved).toEqual(true);
      expect(twoRejected).toEqual(false);
      expect(twoResolved).toEqual(true);

      // these two had the same input and started from a fresh thread, so of course they should be equal.
      expect(thread1Execution1Result).toEqual(thread2Execution1Result);

      // neither thread1 result should match the state written after the first attempt at thread2 execution 2 (because it aborted)
      expect(thread1Execution1Result).not.toEqual(
        thread2Execution2Attempt1Result
      );
      expect(thread1Execution2Result).not.toEqual(
        thread2Execution2Attempt1Result
      );

      // this proves that the second attempt at thread2 execution 2 starts from the last good state
      // (the state after execution 1 completed successfully)
      expect(thread1Execution2Result).toEqual(thread2Execution2Attempt2Result);

      if (["Single layer graph", "Subgraph called as node"].includes(mode)) {
        expect(thread1Execution1Result.nodeLog).toEqual({
          "1": new Set(["one", "two"]),
        });
        expect(thread1Execution2Result.nodeLog).toEqual({
          "1": new Set(["one", "two"]),
          "2": new Set(["one", "two"]),
        });
      } else if (mode.startsWith("Subgraph called within node")) {
        expect(thread1Execution1Result.nodeLog).toEqual({
          "1": new Set(["graph", "one", "two"]),
        });
        expect(thread1Execution2Result.nodeLog).toEqual({
          "1": new Set(["graph", "one", "two"]),
          "2": new Set(["graph", "one", "two"]),
        });
      }
    }
  );
});
