import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { task, entrypoint } from "../func.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { Command } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { MemorySaverAssertImmutable, skipIf } from "./utils.js";
import { Annotation, START, StateGraph } from "../graph/index.js";
import { gatherIterator } from "../utils.js";

/*
  Note: the following python tests weren't ported over, for the reasons listed:

  - test_imp_task_cancel:
    - we can't cancel in the middle of a task like the python implementation can, but we can prevent the graph from finishing using an AbortSignal
    - the equivalent test would've just boiled down to a basic interrupt test
*/

export function runFuncTests(
  createCheckpointer: () => BaseCheckpointSaver | Promise<BaseCheckpointSaver>,
  teardown?: () => unknown
) {
  if (teardown !== undefined) {
    afterAll(teardown);
  }

  beforeAll(() => {
    // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
    initializeAsyncLocalStorageSingleton();
  });

  describe("task and entrypoint decorators", () => {
    describe.each([true, false])(
      `with checkpointer: %s`,
      (withCheckpointer) => {
        let checkpointer: BaseCheckpointSaver | undefined;
        let thread_id: string | undefined;

        beforeEach(async () => {
          checkpointer = withCheckpointer
            ? await createCheckpointer()
            : undefined;

          thread_id = withCheckpointer ? "1" : undefined;
        });

        it("basic task and entrypoint", async () => {
          // equivalent to `test_imp_task` in python tests
          let mapperCallCount = 0;

          // Define a simple mapper task
          const mapper = task("mapper", (input: number) => {
            mapperCallCount += 1;
            return `${input}${input}`;
          });

          let entrypointCallCount = 0;

          // Create a graph using entrypoint
          const graph = entrypoint(
            { checkpointer, name: "graph" },
            async (inputs: number[]) => {
              entrypointCallCount += 1;
              return Promise.all(inputs.map((i) => mapper(i)));
            }
          );

          // Test the graph - pass array of inputs as first argument
          const result = await graph.invoke([[1, 2, 3]], {
            configurable: { thread_id },
          });

          expect(result).toEqual(["11", "22", "33"]);
          expect(mapperCallCount).toBe(3);
          expect(entrypointCallCount).toBe(1);
        });

        skipIf(() => !withCheckpointer)(
          "can call a StateGraph from a task, with interrupt in parent graph",
          async () => {
            // equivalent to `test_imp_nested` in python tests
            const State = Annotation.Root({
              data: Annotation<string[]>({
                reducer: (_, b) => b,
              }),
            });

            function mynode({ data: input }: typeof State.State) {
              return { data: input.map((it) => `${it}a`) };
            }

            const builder = new StateGraph(State)
              .addNode("mynode", mynode)
              .addEdge(START, "mynode");

            const addA = builder.compile({ checkpointer });

            const submapper = task("submapper", (data: number) => {
              return data.toString();
            });

            const mapper = task("mapper", async (data: number) => {
              await new Promise((resolve) => {
                setTimeout(resolve, Math.max(data / 100, 1));
              });

              const sub = await submapper(data);
              return `${sub}${sub}`;
            });

            let capturedOutput: string[] | undefined;

            const graph = entrypoint(
              { name: "graph", checkpointer },
              async (data: number[]) => {
                const mapped = await Promise.all(
                  data.map(async (i) => await mapper(i))
                );
                const answer = await interrupt("question");
                const final = mapped.map((m) => m + answer);
                const { data: output } = await addA.invoke({ data: final });
                capturedOutput = output;
                return output;
              }
            );

            const results = await gatherIterator(
              graph.stream([[0, 1]], { configurable: { thread_id } })
            );

            expect(results.length).toEqual(5);
            expect(results[0]).toEqual({ submapper: "0" });
            expect(results[1]).toEqual({ mapper: "00" });
            expect(results[2]).toEqual({ submapper: "1" });
            expect(results[3]).toEqual({ mapper: "11" });
            const {
              __interrupt__: [inter],
            } = results[4] as {
              __interrupt__: [
                {
                  value: string;
                  resumable: boolean;
                  ns: string[];
                  when: string;
                }
              ];
            };

            expect(inter.value).toEqual("question");
            expect(inter.resumable).toEqual(true);
            expect(inter.ns.length).toEqual(1);
            expect(inter.ns[0]).toMatch(/^graph:/);
            expect(inter.when).toEqual("during");

            const result = await graph.invoke(
              new Command({ resume: "answer" }),
              { configurable: { thread_id } }
            );

            expect(capturedOutput).toEqual(["00answera", "11answera"]);
            expect(result.length).toEqual(capturedOutput?.length);
            expect(result).toEqual(capturedOutput);
          }
        );

        it("should be cancelable via AbortSignal", async () => {
          // validates that we can stop a graph from progressing by triggering an AbortSignal
          // note that we can't halt active tasks this way, but we can prevent the graph from executing new tasks

          let mapperCalls = 0;
          const mapper = task("mapper", async (input: number | string) => {
            mapperCalls += 1;
            await new Promise((resolve) => {
              setTimeout(resolve, 100);
            });
            return `${input}${input}`;
          });

          const graph = entrypoint(
            { checkpointer, name: "cancelableGraph" },
            async (inputs: number[]) => {
              const results = await Promise.all(
                (await Promise.all(inputs.map(mapper))).map(mapper)
              );
              return results;
            }
          );

          const abortController = new AbortController();
          const { signal } = abortController;

          const result = await graph.invoke([[1, 2, 3]], {
            configurable: { thread_id },
            signal,
          });

          expect(result).toEqual(["1111", "2222", "3333"]);
          expect(mapperCalls).toBe(6);

          setTimeout(() => {
            abortController.abort();
          }, 30);

          await expect(async () => {
            await graph.invoke([[1, 2, 3]], {
              configurable: { thread_id },
              signal,
            });
          }).rejects.toThrow(/abort/i);

          // wait for tasks to finish, in case the pregel loop didn't actually abort
          await new Promise((resolve) => {
            setTimeout(resolve, 150);
          });
          expect(mapperCalls).toBe(9);
        });

        it("streams in the correct order", async () => {
          // equivalent to `test_imp_stream_order` in python tests
          interface State {
            a: string;
            b?: string;
            c?: string;
          }

          const foo = task("foo", async (state: State): Promise<State> => {
            return { a: `${state.a}foo`, b: "bar" };
          });

          const bar = task(
            "bar",
            async (a: string, b: string, c?: string): Promise<State> => {
              return { a: a + b, c: `${c || ""}bark` };
            }
          );

          const baz = task("baz", async (state: State): Promise<State> => {
            return { a: `${state.a}baz`, c: "something else" };
          });

          const graph = entrypoint(
            { checkpointer, name: "graph" },
            async (state: State): Promise<State> => {
              const fooRes = await foo(state);
              const barRes = await bar(fooRes.a, fooRes.b!);
              const bazRes = await baz(barRes);
              return bazRes;
            }
          );

          const results = await gatherIterator(
            graph.stream([{ a: "0" }], { configurable: { thread_id } })
          );

          expect(results).toEqual([
            { foo: { a: "0foo", b: "bar" } },
            { bar: { a: "0foobar", c: "bark" } },
            { baz: { a: "0foobarbaz", c: "something else" } },
            { graph: { a: "0foobarbaz", c: "something else" } },
          ]);
        });

        it("multiple tasks with different timings", async () => {
          const delay = 10; // 10ms delay

          const slowMapper = task("slowMapper", async (input: number) => {
            // eslint-disable-next-line no-promise-executor-return
            await new Promise((resolve) => setTimeout(resolve, delay * input));
            return `${input}${input}`;
          });

          const graph = entrypoint(
            { checkpointer, name: "parallelGraph" },
            async (inputs: number[]) => {
              const startTime = Date.now();
              const results = await Promise.all(
                inputs.map((i) => slowMapper(i))
              );
              const endTime = Date.now();

              // The total time should be close to the longest task's time
              // We add some buffer for test stability
              expect(endTime - startTime).toBeLessThan(
                delay * Math.max(...inputs) * 1.5
              );

              return results;
            }
          );

          const result = await graph.invoke([[1, 2, 3]], {
            configurable: { thread_id },
          });

          expect(result).toEqual(["11", "22", "33"]);
        });

        skipIf(() => !withCheckpointer)("task with interrupts", async () => {
          let taskCallCount = 0;

          const interruptingTask = task("interruptTask", async () => {
            taskCallCount += 1;
            return (await interrupt("Please provide input")) as string;
          });

          let graphCallCount = 0;
          const graph = entrypoint(
            { checkpointer, name: "interruptGraph" },
            async (input: string) => {
              graphCallCount += 1;
              const response = await interruptingTask();
              return input + response;
            }
          );

          const config = { configurable: { thread_id } };

          // First run should interrupt - pass single argument as array
          // ideally the withCheckpointer = false case would throw an error here, see https://github.com/langchain-ai/langgraphjs/issues/796
          const firstRun = await graph.invoke(["the correct "], config);

          expect(firstRun).toBeUndefined();
          expect(taskCallCount).toBe(1);
          expect(graphCallCount).toBe(1);

          let currTasks = (await graph.getState(config)).tasks;
          expect(currTasks[0].interrupts).toHaveLength(1);

          // Resume with answer
          const result = await graph.invoke(
            new Command({ resume: "answer" }),
            config
          );

          currTasks = (await graph.getState(config)).tasks;
          expect(currTasks.length).toBe(0);

          expect(result).toBe("the correct answer");
          expect(taskCallCount).toBe(2);
          expect(graphCallCount).toBe(2);
        });

        skipIf(() => !withCheckpointer)(
          "can interrupt the entrypoint",
          async () => {
            // equivalent to `test_interrupt_functional` in python tests
            interface State {
              a: string;
            }

            const foo = task("foo", async (state: State): Promise<State> => {
              return { a: `${state.a}foo` };
            });

            const bar = task(
              "bar",
              async (state: State & { b: string }): Promise<State> => {
                return { a: state.a + state.b };
              }
            );

            const graph = entrypoint(
              { checkpointer, name: "interruptGraph" },
              async (inputs: State) => {
                const fooResult = await foo(inputs);
                const value = await interrupt("Provide value for bar:");
                const barInput = { ...fooResult, b: value as string };
                const barResult = await bar(barInput);
                return barResult;
              }
            );

            const config = { configurable: { thread_id } };

            // First run, interrupted at bar
            const firstRun = await graph.invoke([{ a: "" }], config);
            expect(firstRun).toBeUndefined();

            // Resume with an answer
            const result = await graph.invoke(
              new Command({ resume: "bar" }),
              config
            );

            expect(result).toEqual({ a: "foobar" });
          }
        );

        skipIf(() => !withCheckpointer)("can interrupt tasks", async () => {
          // equivalent to `test_interrupt_task_functional` in python tests
          interface State {
            a: string;
          }

          const foo = task("foo", async (state: State): Promise<State> => {
            return { a: `${state.a}foo` };
          });

          const bar = task("bar", async (state: State): Promise<State> => {
            const value = await interrupt("Provide value for bar:");
            return { a: state.a + value };
          });

          const graph = entrypoint(
            { checkpointer, name: "interruptGraph" },
            async (inputs: State) => {
              const fooResult = await foo(inputs);
              const barResult = await bar(fooResult);
              return barResult;
            }
          );

          const config = { configurable: { thread_id } };

          // First run, interrupted at bar
          const firstRun = await graph.invoke([{ a: "" }], config);
          expect(firstRun).toBeUndefined();

          // Resume with an answer
          const result = await graph.invoke(
            new Command({ resume: "bar" }),
            config
          );

          expect(result).toEqual({ a: "foobar" });
        });

        it("task with retry policy", async () => {
          let attempts = 0;

          const failingTask = task(
            "failingTask",
            () => {
              attempts += 1;
              if (attempts < 3) {
                throw new Error("Task failed");
              }
              return "success";
            },
            { retry: { maxAttempts: 3 } }
          );

          const graph = entrypoint(
            { checkpointer, name: "retryGraph" },
            async () => failingTask()
          );

          const result = await graph.invoke([], {
            configurable: { thread_id },
          });

          expect(result).toBe("success");
          expect(attempts).toBe(3);
        });

        it("should stream results", async () => {
          const timeDelay = 10; // 10ms delay

          const slowTask = task("slowTask", async () => {
            // eslint-disable-next-line no-promise-executor-return
            await new Promise((resolve) => setTimeout(resolve, timeDelay));
            return { timestamp: Date.now() };
          });

          const graph = entrypoint({ name: "streamGraph" }, async () => {
            const first = await slowTask();
            const second = await slowTask();
            return [first, second];
          });

          const arrivalTimes: number[] = [];

          // Using for-await to process the stream - pass empty array since no args needed
          for await (const chunk of await graph.stream([])) {
            const now = Date.now();
            if ("slowTask" in chunk) {
              arrivalTimes.push(now);
            }
          }

          expect(arrivalTimes.length).toBe(2);
          const timeDiff = arrivalTimes[1] - arrivalTimes[0];
          // Time difference should be at least the delay
          expect(timeDiff).toBeGreaterThanOrEqual(timeDelay);
        });

        skipIf(() => !withCheckpointer)(
          "can handle falsy return values from tasks",
          async () => {
            // equivalent to `test_falsy_return_from_task` in python tests
            const falsyTask = task("falsyTask", async () => {
              return false;
            });

            const graph = entrypoint(
              { checkpointer, name: "falsyGraph" },
              async (_state: Record<string, unknown>) => {
                await falsyTask();
                await interrupt("test");
              }
            );

            const config = { configurable: { thread_id } };

            // First run should interrupt
            const firstRun = await graph.invoke([{ a: 5 }], config);
            expect(firstRun).toBeUndefined();

            // Resume with answer
            const result = await graph.invoke(
              new Command({ resume: "123" }),
              config
            );

            expect(result).toBeUndefined();
          }
        );

        // skipped because it's not implemented yet
        skipIf(() => !withCheckpointer)(
          "handles multiple interrupts in an imperative style",
          async () => {
            // equivalent to `test_multiple_interrupts_imperative` in python tests
            let counter = 0;

            const double = task(
              "double",
              async (x: number): Promise<number> => {
                counter += 1;
                return 2 * x;
              }
            );

            const graph = entrypoint(
              { checkpointer, name: "graph" },
              async () => {
                const values: (number | string)[] = [];

                for (const idx of [1, 2, 3]) {
                  values.push(await double(idx));
                  values.push(await interrupt({ a: `boo${idx}` }));
                }

                return { values };
              }
            );

            const config = { configurable: { thread_id } };

            // First run should interrupt
            const firstRun = await graph.invoke([], config);
            expect(firstRun).toBeUndefined();

            // Resume with first answer
            const secondRun = await graph.invoke(
              new Command({ resume: "a" }),
              config
            );

            // TODO: why u null?! seems to be coming from an attempt to read the output of __end__, but why doesn't it do that in the first run?
            expect(secondRun).toBeNull();

            // Resume with second answer
            const thirdRun = await graph.invoke(
              new Command({ resume: "b" }),
              config
            );

            // TODO: why u null?! seems to be coming from an attempt to read the output of __end__, but why doesn't it do that in the first run?
            expect(thirdRun).toBeNull();

            // Resume with final answer and get result
            const result = await graph.invoke(
              new Command({ resume: "c" }),
              config
            );

            expect(result).toEqual({
              values: [2, "a", 4, "b", 6, "c"],
            });

            // Verify double() was only called 3 times (cached appropriately)
            expect(counter).toBe(3);
          }
        );
      }
    );
  });
}

runFuncTests(() => new MemorySaverAssertImmutable());
