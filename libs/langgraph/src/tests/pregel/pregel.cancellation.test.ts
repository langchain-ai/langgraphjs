import { beforeAll, describe, expect, it } from "@jest/globals";
import {
  CompiledStateGraph,
  END,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "../../index.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";

type TestMode =
  | "singleLayer"
  | "subgraphCalledWithinNodeWithoutConfig"
  | "subgraphCalledWithinNodeWithConfig"
  | "subgraphCalledAsNode";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

describe("Pregel AbortSignal", () => {
  let oneCount = 0;
  let oneResolved = false;
  let oneRejected = false;
  let twoCount = 0;

  beforeEach(() => {
    oneCount = 0;
    oneResolved = false;
    oneRejected = false;
    twoCount = 0;
  });

  function createGraph({
    mode,
    checkSignal,
  }: {
    mode: TestMode;
    checkSignal: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): CompiledStateGraph<any, any, any> {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", async (_, config: LangGraphRunnableConfig) => {
        oneCount += 1;
        if (checkSignal) {
          const { signal } = config;
          expect(signal).toBeDefined();
          return new Promise((resolve, reject) => {
            signal!.addEventListener("abort", () => {
              oneRejected = true;
              reject(new Error("Aborted"));
            });
            setTimeout(() => {
              if (!signal!.aborted) {
                oneResolved = true;
                resolve({});
              }
            }, 50);
          });
        } else {
          await new Promise((resolve) => {
            oneResolved = true;
            setTimeout(resolve, 100);
          });
          return {};
        }
      })
      .addNode("two", () => {
        twoCount += 1;
        throw new Error("Should not be called!");
      })
      .addEdge(START, "one")
      .addEdge("one", "two")
      .addEdge("two", END)
      .compile();

    if (mode === "singleLayer") {
      return graph;
    }

    if (mode === "subgraphCalledWithinNodeWithoutConfig") {
      return new StateGraph(MessagesAnnotation)
        .addNode("graph", async () => {
          await graph.invoke({ messages: [] });
        })
        .addEdge(START, "graph")
        .addEdge("graph", END)
        .compile();
    }
    if (mode === "subgraphCalledWithinNodeWithConfig") {
      return new StateGraph(MessagesAnnotation)
        .addNode("graph", async (_, config: LangGraphRunnableConfig) => {
          await graph.invoke({ messages: [] }, config);
        })
        .addEdge(START, "graph")
        .addEdge("graph", END)
        .compile();
    }

    return new StateGraph(MessagesAnnotation)
      .addNode("graph", graph)
      .addEdge(START, "graph")
      .addEdge("graph", END)
      .compile();
  }

  it.each([
    "singleLayerGraph",
    "subgraphCalledWithinNodeWithoutConfig",
    "subgraphCalledWithinNodeWithConfig",
    "subgraphCalledAsNode",
  ] as TestMode[])(
    "should cancel when external AbortSignal is aborted (%s)",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
      };

      setTimeout(() => abortController.abort(), 10);

      await expect(
        async () =>
          await createGraph({ mode, checkSignal: false }).invoke(
            {
              messages: [],
            },
            config
          )
      ).rejects.toThrow("Aborted");

      // Ensure that the `twoCount` has had time to increment before we check it, in case the stream aborted but the graph execution didn't.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(oneCount).toEqual(1);
      expect(twoCount).toEqual(0);
    }
  );

  it.each([
    "singleLayerGraph",
    "subgraphCalledWithinNodeWithoutConfig",
    "subgraphCalledWithinNodeWithConfig",
    "subgraphCalledAsNode",
  ] as TestMode[])(
    "should pass AbortSignal into nodes via config when timeout is provided but no external signal is given (%s)",
    async (mode) => {
      const config = {
        timeout: 10,
      };

      await expect(
        async () =>
          await createGraph({ mode, checkSignal: true }).invoke(
            {
              messages: [],
            },
            config
          )
      ).rejects.toThrow("Aborted");

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
    "singleLayerGraph",
    "subgraphCalledWithinNodeWithoutConfig",
    "subgraphCalledWithinNodeWithConfig",
    "subgraphCalledAsNode",
  ] as TestMode[])(
    "should trigger AbortSignal that is passed to node on timeout when both signal and timeout are set on invocation (%s)",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
        timeout: 10,
      };

      await expect(
        async () =>
          await createGraph({ mode, checkSignal: true }).invoke(
            {
              messages: [],
            },
            config
          )
      ).rejects.toThrow("Aborted");

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
    "singleLayerGraph",
    "subgraphCalledWithinNodeWithoutConfig",
    "subgraphCalledWithinNodeWithConfig",
    "subgraphCalledAsNode",
  ] as TestMode[])(
    "should trigger AbortSignal that is passed to node when external signal triggered when both signal and timeout are set on invocation (%s)",
    async (mode) => {
      const abortController = new AbortController();
      const config = {
        signal: abortController.signal,
        timeout: 100,
      };

      setTimeout(() => abortController.abort(), 10);

      await expect(
        async () =>
          await createGraph({ mode, checkSignal: true }).invoke(
            {
              messages: [],
            },
            config
          )
      ).rejects.toThrow("Aborted");

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
});
