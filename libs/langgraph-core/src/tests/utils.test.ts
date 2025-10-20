import { it, expect, describe, beforeAll, afterAll } from "vitest";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { MemorySaverAssertImmutable } from "./utils.js";
import { gatherIterator } from "../utils.js";
import { Annotation, StateGraph } from "../graph/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { Command, entrypoint, getCurrentTaskInput, task } from "../index.js";

export function runUtilsTests(
  createCheckpointer: () => BaseCheckpointSaver | Promise<BaseCheckpointSaver>,
  teardown?: () => Promise<void>
) {
  if (teardown !== undefined) {
    afterAll(teardown);
  }

  beforeAll(() => {
    // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
    initializeAsyncLocalStorageSingleton();
  });

  describe("getCurrentTaskInput", () => {
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    describe("StateGraph", () => {
      function check(input: typeof StateAnnotation.State) {
        expect(getCurrentTaskInput()).toEqual(input);
        return { foo: `check${input.count + 1}`, count: input.count + 1 };
      }

      function checkCommand(input: typeof StateAnnotation.State) {
        expect(getCurrentTaskInput()).toEqual(input);
        return new Command({
          update: {
            foo: `checkCommand${input.count + 1}`,
            count: input.count + 1,
          },
        });
      }

      function getCheckGotoCommand(goto: string) {
        function checkGotoCommand(input: typeof StateAnnotation.State) {
          expect(getCurrentTaskInput()).toEqual(input);
          return new Command({
            update: {
              foo: `checkGotoCommand${input.count + 1}`,
              count: input.count + 1,
            },
            goto,
          });
        }
        return checkGotoCommand;
      }

      function getCheckParentCommand(goto?: string) {
        function checkGotoParentCommand(input: typeof StateAnnotation.State) {
          expect(getCurrentTaskInput()).toEqual(input);
          return new Command({
            update: {
              foo: `checkGotoParentCommand${input.count + 1}`,
              count: input.count + 1,
            },
            goto,
            graph: Command.PARENT,
          });
        }
        return checkGotoParentCommand;
      }

      it.each([() => undefined, createCheckpointer])(
        "should return the input for nodes in a single level graph",
        async (createCheckpointer) => {
          const graph = new StateGraph(StateAnnotation)
            .addNode("check", check)
            .addNode("checkCommand", checkCommand)
            .addNode("checkGotoCommand", getCheckGotoCommand("finalCheck"), {
              ends: ["finalCheck"],
            })
            .addNode("finalCheck", check)
            .addEdge("__start__", "check")
            .addEdge("check", "checkCommand")
            .addEdge("checkCommand", "checkGotoCommand")
            .addEdge("finalCheck", "__end__")
            .compile({
              checkpointer: await createCheckpointer(),
            });

          const values = await gatherIterator(
            graph.stream(
              {},
              {
                streamMode: "updates",
                configurable: { thread_id: "1" },
              }
            )
          );

          expect(values.length).toBe(4);
          expect(values[0]).toEqual({ check: { foo: "check1", count: 1 } });
          expect(values[1]).toEqual({
            checkCommand: { foo: "checkCommand2", count: 2 },
          });
          expect(values[2]).toEqual({
            checkGotoCommand: { foo: "checkGotoCommand3", count: 3 },
          });
          expect(values[3]).toEqual({
            finalCheck: { foo: "check4", count: 4 },
          });
        }
      );

      it.each([() => undefined, createCheckpointer])(
        "should return the input for nodes in a two level graph",
        async (createCheckpointer) => {
          const subgraph = new StateGraph(StateAnnotation)
            .addNode("check", check)
            .addNode("checkCommand", checkCommand)
            .addNode("checkGotoCommand", getCheckGotoCommand("finalCheck"), {
              ends: ["finalCheck"],
            })
            .addNode("finalCheck", check)
            .addEdge("__start__", "check")
            .addEdge("check", "checkCommand")
            .addEdge("checkCommand", "checkGotoCommand")
            .addEdge("finalCheck", "__end__")
            .compile({
              checkpointer: await createCheckpointer(),
            });

          const graph = new StateGraph(StateAnnotation)
            .addNode("check", check)
            .addNode("subgraph", subgraph)
            .addNode("finalCheck", check)
            .addEdge("__start__", "check")
            .addEdge("check", "subgraph")
            .addEdge("subgraph", "finalCheck")
            .addEdge("finalCheck", "__end__")
            .compile({
              checkpointer: await createCheckpointer(),
            });

          const values = await gatherIterator(
            graph.stream(
              {},
              {
                streamMode: "values",
                subgraphs: true,
                configurable: { thread_id: "1" },
              }
            )
          );

          expect(values.length).toBe(8);
          expect(values[0]).toEqual([[], { foo: "check1", count: 1 }]);

          // emitted when subgraph is called before first node is invoked
          expect(values[1][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[1][1]).toEqual({ foo: "check1", count: 1 });

          // result of first subgraph node invocation
          expect(values[2][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[2][1]).toEqual({ foo: "check2", count: 2 });

          // result of second subgraph node invocation
          expect(values[3][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[3][1]).toEqual({ foo: "checkCommand3", count: 3 });

          // result of third subgraph node invocation
          expect(values[4][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[4][1]).toEqual({ foo: "checkGotoCommand4", count: 4 });

          // result of final subgraph node invocation
          expect(values[5][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[5][1]).toEqual({ foo: "check5", count: 5 });

          // result of parent node that calls subgraph
          expect(values[6]).toEqual([[], { foo: "check5", count: 5 }]);

          // result of final node invocation
          expect(values[7]).toEqual([[], { foo: "check6", count: 6 }]);
        }
      );

      it.each([() => undefined, createCheckpointer])(
        "should return the input for nodes in a two level StateGraph that uses Command.PARENT",
        async (createCheckpointer) => {
          const subgraph = new StateGraph(StateAnnotation)
            .addNode("check", check)
            .addNode("checkCommand", checkCommand)
            .addNode(
              "checkGotoParentCommand",
              getCheckParentCommand("finalCheck")
            )
            .addEdge("__start__", "check")
            .addEdge("check", "checkCommand")
            .addEdge("checkCommand", "checkGotoParentCommand")
            .compile({
              checkpointer: await createCheckpointer(),
            });

          const graph = new StateGraph(StateAnnotation)
            .addNode("check", check)
            .addNode("subgraph", subgraph, { ends: ["finalCheck"] })
            .addNode("finalCheck", check)
            .addEdge("__start__", "check")
            .addEdge("check", "subgraph")
            .compile({
              checkpointer: await createCheckpointer(),
            });

          const values = await gatherIterator(
            graph.stream(
              {},
              {
                streamMode: "values",
                subgraphs: true,
                configurable: { thread_id: "1" },
              }
            )
          );

          expect(values.length).toBe(6);
          expect(values[0]).toEqual([[], { foo: "check1", count: 1 }]);

          // emitted when subgraph is called before first node is invoked
          expect(values[1][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[1][1]).toEqual({ foo: "check1", count: 1 });

          // result of first subgraph node invocation
          expect(values[2][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[2][1]).toEqual({ foo: "check2", count: 2 });

          // result of second subgraph node invocation
          expect(values[3][0]).toEqual([
            expect.stringMatching(/^subgraph:.*$/),
          ]);
          expect(values[3][1]).toEqual({ foo: "checkCommand3", count: 3 });

          // result of parent node that calls subgraph
          expect(values[4]).toEqual([
            [],
            { foo: "checkGotoParentCommand4", count: 4 },
          ]);

          // result of final node invocation
          expect(values[5]).toEqual([[], { foo: "check5", count: 5 }]);
        }
      );
    });

    describe("Functional API", () => {
      function check(input: typeof StateAnnotation.State) {
        expect(getCurrentTaskInput()).toEqual([input]);
        return { foo: `check${input.count + 1}`, count: input.count + 1 };
      }

      function checkCommand(input: typeof StateAnnotation.State) {
        expect(getCurrentTaskInput()).toEqual([input]);
        return new Command({
          update: {
            foo: `checkCommand${input.count + 1}`,
            count: input.count + 1,
          },
        });
      }

      it.each([() => undefined, createCheckpointer])(
        "should return the input for nodes in a single level graph",
        async (createCheckpointer) => {
          const graph = entrypoint(
            {
              name: "graph",
              checkpointer: await createCheckpointer(),
            },
            async (input: typeof StateAnnotation.State) => {
              expect(getCurrentTaskInput()).toEqual(input);
              const out1 = await task("check", check)(input);
              const out2 = (await task(
                "checkCommand",
                checkCommand
              )(out1)) as unknown as typeof StateAnnotation.State;
              const out3 = await task("finalCheck", check)(out2);
              return out3;
            }
          );

          await graph.invoke(
            { foo: "", count: 0 },
            { configurable: { thread_id: "1" } }
          );
        }
      );

      it.each([() => undefined, createCheckpointer])(
        "should return the input for nodes in a two level graph",
        async (createCheckpointer) => {
          const subgraph = entrypoint(
            {
              name: "graph",
              checkpointer: await createCheckpointer(),
            },
            async (input: typeof StateAnnotation.State) => {
              expect(getCurrentTaskInput()).toEqual(input);
              const out1 = await task("check", check)(input);
              const out2 = (await task(
                "checkCommand",
                checkCommand
              )(out1)) as unknown as typeof StateAnnotation.State;
              const out3 = await task("finalCheck", check)(out2);
              return out3;
            }
          );

          const graph = entrypoint(
            {
              name: "graph",
              checkpointer: await createCheckpointer(),
            },
            async (input: typeof StateAnnotation.State) => {
              expect(getCurrentTaskInput()).toEqual(input);
              const out1 = await task("check", check)(input);
              const out2 = await subgraph.invoke(out1);
              const out3 = await task("finalCheck", check)(out2);
              return out3;
            }
          );

          await graph.invoke(
            { foo: "", count: 0 },
            { configurable: { thread_id: "1" } }
          );
        }
      );
    });
  });
}

runUtilsTests(() => new MemorySaverAssertImmutable());
