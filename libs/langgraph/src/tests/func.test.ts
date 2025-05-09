import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { task, entrypoint, getPreviousState } from "../func/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { Command, PREVIOUS, START } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { MemorySaverAssertImmutable } from "./utils.js";
import { Annotation, StateGraph } from "../graph/index.js";
import { gatherIterator } from "../utils.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

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
          const result = await graph.invoke([1, 2, 3], {
            configurable: { thread_id },
          });

          expect(result).toEqual(["11", "22", "33"]);
          expect(mapperCallCount).toBe(3);
          expect(entrypointCallCount).toBe(1);
        });

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

          const result = await graph.invoke([1, 2, 3], {
            configurable: { thread_id },
            signal,
          });

          expect(result).toEqual(["1111", "2222", "3333"]);
          expect(mapperCalls).toBe(6);

          setTimeout(() => {
            abortController.abort();
          }, 30);

          await expect(async () => {
            await graph.invoke([1, 2, 3], {
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
            graph.stream({ a: "0" }, { configurable: { thread_id } })
          );

          expect(results).toEqual([
            { foo: { a: "0foo", b: "bar" } },
            { bar: { a: "0foobar", c: "bark" } },
            { baz: { a: "0foobarbaz", c: "something else" } },
            { graph: { a: "0foobarbaz", c: "something else" } },
          ]);
        });

        it("task with retry policy", async () => {
          let attempts = 0;

          const failingTask = task(
            {
              name: "failingTask",
              retry: { maxAttempts: 3, logWarning: false },
            },
            () => {
              attempts += 1;
              if (attempts < 3) {
                throw new Error("Task failed");
              }
              return "success";
            }
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

        it("should send updates immediately when streaming", async () => {
          let lastIdx = null;

          const slowTask = task("slowTask", async (idx: number) => {
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
            lastIdx = idx;
            return { idx };
          });

          const graph = entrypoint(
            { name: "streamGraph", checkpointer },
            async () => {
              const first = await slowTask(0);
              const second = await slowTask(1);
              return [first, second];
            }
          );

          const config = {
            configurable: { thread_id },
          };

          // Using for-await to process the stream - pass empty array since no args needed
          for await (const chunk of await graph.stream([], config)) {
            if ("slowTask" in chunk) {
              expect(chunk.slowTask.idx).toBe(lastIdx);
            }
          }
        });

        it("can use a stream writer", async () => {
          const graph = entrypoint(
            { name: "graph", checkpointer },
            async (input: string, config: LangGraphRunnableConfig) => {
              config.writer?.(`hello ${input}`);
              await new Promise((resolve) => {
                setTimeout(resolve, 100);
              });
              config.writer?.(`hello again, ${input}`);
              return `goodbye, ${input}`;
            }
          );

          const config = { configurable: { thread_id } };
          expect(await graph.invoke("world", config)).toEqual("goodbye, world");

          expect(
            await gatherIterator(
              graph.stream("world", { ...config, streamMode: "custom" })
            )
          ).toEqual(["hello world", "hello again, world"]);
        });

        it("can stream subgraph results", async () => {
          const subgraph = entrypoint(
            { name: "subgraph", checkpointer },
            async (input: string, config: LangGraphRunnableConfig) => {
              config.writer?.(`hello ${input}`);
              await new Promise((resolve) => {
                setTimeout(resolve, 100);
              });
              config.writer?.(`hello again, ${input}`);
              return `goodbye, ${input}`;
            }
          );

          const graph = entrypoint(
            { name: "graph", checkpointer },
            async (input: string, config: LangGraphRunnableConfig) => {
              const subgraphResult = await subgraph.stream(input);
              for await (const chunk of subgraphResult) {
                config.writer?.(chunk);
              }
              return "done";
            }
          );

          const config = { configurable: { thread_id } };
          expect(await graph.invoke("world", config)).toEqual("done");

          expect(
            await gatherIterator(
              graph.stream("world", { ...config, streamMode: "custom" })
            )
          ).toEqual(["hello world", "hello again, world", "goodbye, world"]);
        });

        it("propagates errors thrown from entrypoints", async () => {
          const graph = entrypoint(
            { name: "graph", checkpointer },
            async () => {
              throw new Error("test error");
            }
          );

          const config = { configurable: { thread_id } };
          await expect(graph.invoke([], config)).rejects.toThrow("test error");
        });

        it("propagates errors thrown from tasks", async () => {
          const errorTask = task("errorTask", () => {
            throw new Error("test error");
          });

          const graph = entrypoint(
            { name: "graph", checkpointer },
            async () => {
              await errorTask();
            }
          );

          const config = { configurable: { thread_id } };
          await expect(graph.invoke([], config)).rejects.toThrow("test error");
        });

        describe("generator functions", () => {
          it("disallows use of generator as an entrypoint", async () => {
            expect(() =>
              entrypoint(
                { name: "graph", checkpointer },
                // we need ts-expect-error here because the type system also guards against this
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                function* () {
                  yield "a";
                  yield "b";
                }
              )
            ).toThrow(
              "Generators are disallowed as entrypoints. For streaming responses, use config.write."
            );
          });

          it("disallows use of async generator as an entrypoint", async () => {
            expect(() =>
              entrypoint(
                { name: "graph", checkpointer },
                // we need ts-expect-error here because the type system also guards against this
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                async function* () {
                  await Promise.resolve(); // useless thing just to make it async
                  yield "a";
                  yield "b";
                }
              )
            ).toThrow(
              "Generators are disallowed as entrypoints. For streaming responses, use config.write."
            );
          });

          it("disallows use of generator as a task", async () => {
            expect(() =>
              task(
                "task",
                // we need ts-expect-error here because the type system also guards against this
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                function* () {
                  yield "a";
                  yield "b";
                }
              )
            ).toThrow(
              "Generators are disallowed as tasks. For streaming responses, use config.write."
            );
          });

          it("disallows use of async generator as a task", async () => {
            expect(() =>
              task(
                "task",
                // we need ts-expect-error here because the type system also guards against this
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                async function* () {
                  await Promise.resolve(); // useless thing just to make it async
                  yield "a";
                  yield "b";
                }
              )
            ).toThrow(
              "Generators are disallowed as tasks. For streaming responses, use config.write."
            );
          });
        });
      }
    );

    describe("persistence", () => {
      let checkpointer: BaseCheckpointSaver | undefined;
      let thread_id: string | undefined;

      beforeEach(async () => {
        checkpointer = await createCheckpointer();
        thread_id = "1";
      });

      it("can return a final value separately from the persisted value", async () => {
        const graph = entrypoint(
          { name: "graph", checkpointer },
          async (input: number) => {
            const previous = getPreviousState<number>();

            return entrypoint.final({
              value: input + (previous ?? 0),
              save: input,
            });
          }
        );

        const config = {
          configurable: { thread_id },
        };

        const first = await graph.invoke(1, config);
        const second = await graph.invoke(2, config);
        const third = await graph.invoke(3, config);
        const state = await graph.getState(config);
        const checkpointConfig = state.config;
        const checkpoint = await checkpointer?.get(checkpointConfig);
        const previous = checkpoint?.channel_values[PREVIOUS];

        expect(first).toEqual(1);
        expect(second).toEqual(3);
        expect(third).toEqual(5);
        expect(previous).toEqual(3);
      });

      it("stores previous returned value in state", async () => {
        // equivalent to `test_entrypoint_stateful` in python tests
        const previousStates: unknown[] = [];

        const graph = entrypoint(
          { name: "graph", checkpointer },
          async (inputs: Record<string, string>) => {
            const previous = getPreviousState<unknown>();
            previousStates.push(previous);
            return {
              previous,
              current: inputs,
            };
          }
        );

        const config = {
          configurable: { thread_id },
        };

        expect(await graph.invoke({ a: "1" }, config)).toEqual({
          current: { a: "1" },
        });

        expect(await graph.invoke({ a: "2" }, config)).toEqual({
          current: { a: "2" },
          previous: { current: { a: "1" } },
        });

        expect(await graph.invoke({ a: "3" }, config)).toEqual({
          current: { a: "3" },
          previous: {
            current: { a: "2" },
            previous: { current: { a: "1" } },
          },
        });

        // new thread, so no previous state should be visible
        expect(
          await graph.invoke({ a: "4" }, { configurable: { thread_id: "0" } })
        ).toEqual({
          current: { a: "4" },
        });

        // same thread, so previous state should be visible
        expect(
          await graph.invoke({ a: "5" }, { configurable: { thread_id: "0" } })
        ).toEqual({
          current: { a: "5" },
          previous: {
            current: { a: "4" },
          },
        });

        expect(previousStates).toEqual([
          undefined,
          { current: { a: "1" }, previous: undefined },
          {
            current: { a: "2" },
            previous: { current: { a: "1" }, previous: undefined },
          },
          undefined, // start of new thread
          {
            current: { a: "4" },
            previous: undefined,
          },
        ]);
      });
    });

    describe("interrupt handling", () => {
      let checkpointer: BaseCheckpointSaver | undefined;
      let thread_id: string | undefined;

      beforeEach(async () => {
        checkpointer = await createCheckpointer();
        thread_id = "1";
      });

      it("can call a StateGraph from a task, with interrupt in parent graph", async () => {
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
          graph.stream([0, 1], { configurable: { thread_id } })
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

        const result = await graph.invoke(new Command({ resume: "answer" }), {
          configurable: { thread_id },
        });

        expect(capturedOutput).toEqual(["00answera", "11answera"]);
        expect(result.length).toEqual(capturedOutput?.length);
        expect(result).toEqual(capturedOutput);
      });
      it("task with interrupts", async () => {
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
        const firstRun = await graph.invoke("the correct ", config);

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

      it("can interrupt the entrypoint", async () => {
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
        const firstRun = await graph.invoke({ a: "" }, config);
        expect(firstRun).toBeUndefined();

        // Resume with an answer
        const result = await graph.invoke(
          new Command({ resume: "bar" }),
          config
        );

        expect(result).toEqual({ a: "foobar" });
      });

      it("can interrupt tasks", async () => {
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
        const firstRun = await graph.invoke({ a: "" }, config);
        expect(firstRun).toBeUndefined();

        // Resume with an answer
        const result = await graph.invoke(
          new Command({ resume: "bar" }),
          config
        );

        expect(result).toEqual({ a: "foobar" });
      });
      it("can handle falsy return values from tasks", async () => {
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
        const firstRun = await graph.invoke({ a: 5 }, config);
        expect(firstRun).toBeUndefined();

        // Resume with answer
        const result = await graph.invoke(
          new Command({ resume: "123" }),
          config
        );

        expect(result).toBeUndefined();
      });

      it("handles multiple interrupts in an imperative style", async () => {
        // equivalent to `test_multiple_interrupts_imperative` in python tests
        let counter = 0;

        const double = task("double", async (x: number): Promise<number> => {
          counter += 1;
          return 2 * x;
        });

        const graph = entrypoint({ checkpointer, name: "graph" }, async () => {
          const values: (number | string)[] = [];

          for (const idx of [1, 2, 3]) {
            values.push(await double(idx));
            values.push(await interrupt({ a: `boo${idx}` }));
          }

          return { values };
        });

        const config = { configurable: { thread_id } };

        // First run should interrupt
        const firstRun = await graph.invoke([], config);
        expect(firstRun).toBeUndefined();

        // Resume with first answer
        const secondRun = await graph.invoke(
          new Command({ resume: "a" }),
          config
        );

        // TODO: make this return something other than null when we figure out a interrupt return value
        expect(secondRun).toBeNull();

        // Resume with second answer
        const thirdRun = await graph.invoke(
          new Command({ resume: "b" }),
          config
        );

        expect(thirdRun).toBeNull();

        // Resume with final answer and get result
        const result = await graph.invoke(new Command({ resume: "c" }), config);

        expect(result).toEqual({
          values: [2, "a", 4, "b", 6, "c"],
        });

        // Verify double() was only called 3 times (cached appropriately)
        expect(counter).toBe(3);
      });

      it("handles multiple interrupts from tasks", async () => {
        const addParticipant = task("add-participant", async (name: string) => {
          const feedback = interrupt(`Hey do you want to add ${name}?`);

          if (feedback === false) {
            return `The user changed their mind and doesnt want to add ${name}!` as string;
          }

          if (feedback === true) {
            return `Added ${name}!` as string;
          }

          throw new Error("Invalid feedback");
        });

        const program = entrypoint(
          {
            name: "program",
            checkpointer,
          },
          async () => {
            const first = await addParticipant("James");
            const second = await addParticipant("Will");
            return [first, second];
          }
        );

        const config = { configurable: { thread_id } };

        let result = await program.invoke([], config);
        expect(result).toBeUndefined();

        let currTasks = (await program.getState(config)).tasks;
        expect(currTasks[0].interrupts).toHaveLength(1);
        expect(currTasks[0].interrupts[0].value).toEqual(
          "Hey do you want to add James?"
        );
        expect(currTasks[0].interrupts[0].resumable).toEqual(true);
        expect(currTasks[0].interrupts[0].ns!.length).toEqual(2);
        expect(currTasks[0].interrupts[0].ns![0]).toEqual(
          expect.stringMatching(/^program:.*$/)
        );
        expect(currTasks[0].interrupts[0].ns![1]).toEqual(
          expect.stringMatching(/^add-participant:.*$/)
        );
        expect(currTasks[0].interrupts[0].when).toEqual("during");

        result = await program.invoke(new Command({ resume: true }), config);
        expect(result).toBeNull();

        currTasks = (await program.getState(config)).tasks;
        expect(currTasks[0].interrupts).toHaveLength(1);
        expect(currTasks[0].interrupts[0].value).toEqual(
          "Hey do you want to add Will?"
        );
        expect(currTasks[0].interrupts[0].resumable).toEqual(true);
        expect(currTasks[0].interrupts[0].ns!.length).toEqual(2);
        expect(currTasks[0].interrupts[0].ns![0]).toEqual(
          expect.stringMatching(/^program:.*$/)
        );
        expect(currTasks[0].interrupts[0].ns![1]).toEqual(
          expect.stringMatching(/^add-participant:.*$/)
        );
        expect(currTasks[0].interrupts[0].when).toEqual("during");

        result = await program.invoke(new Command({ resume: true }), config);
        expect(result).toEqual(["Added James!", "Added Will!"]);
      });
    });

    describe("updateState functionality", () => {
      let checkpointer: BaseCheckpointSaver;
      let thread_id: string;

      beforeEach(async () => {
        checkpointer = await createCheckpointer();
        thread_id = "updateStateThread";
      });

      it("should allow updating state during an interrupt and resume correctly", async () => {
        const taskOne = task("taskOne", async (input: { value: number }) => {
          return { resultOne: input.value * 2 };
        });

        const taskTwo = task(
          "taskTwo",
          async (input: { intermediate: number; extra?: string }) => {
            return {
              finalResult:
                input.intermediate + (input.extra === "added" ? 100 : 10),
            };
          }
        );

        let runCount = 0;
        let firstExtra: string | undefined;
        let secondExtra: string | undefined;

        const graph = entrypoint(
          { name: "updateStateGraph", checkpointer },
          async ({ value, extra }: { value: number; extra?: string }) => {
            runCount += 1;

            const resOne = await taskOne({ value });
            // The value from interrupt will be the input to taskTwo's 'intermediate'
            const interruptedValue = await interrupt(resOne.resultOne);
            if (runCount === 1) {
              firstExtra = extra;
            } else if (runCount === 2) {
              // We will update 'extra' via updateState, so secondExtra should be different than firstExtra
              secondExtra = extra;
            }

            const resTwo = await taskTwo({
              intermediate: interruptedValue as number,
              extra,
            });

            return resTwo;
          }
        );

        const config = { configurable: { thread_id } };

        // Initial invocation - should interrupt
        const initialInvoke = await graph.invoke({ value: 5 }, config);
        expect(initialInvoke).toBeUndefined(); // Graph is interrupted

        const interruptedState = await graph.getState(config);

        expect(
          interruptedState.tasks.find((t) => (t.interrupts?.length ?? 0) > 0)
            ?.interrupts?.[0].value
        ).toEqual(10);

        const next = interruptedState.next[0];
        const interruptedValues = interruptedState.values;

        console.log("next", next);
        console.log(
          "interruptedValues",
          JSON.stringify(interruptedValues, null, 2)
        );

        // Update the state
        await graph.updateState(config, {
          ...interruptedValues,
          extra: "added",
        });

        // Resume execution
        // The value passed to resume (20) will be what `interruptedValue` becomes.
        const finalValues = await graph.invoke(
          new Command({ resume: 20 }),
          config
        );

        // taskTwo expected: { intermediate: 20, extra: "added" (from updated state) }
        // finalResult should be 20 + 100 = 120
        expect(finalValues).toEqual({ finalResult: 120 });

        // make sure we were called the right number of times
        expect(runCount).toEqual(2);

        // make sure the extra value was updated as expected
        expect(firstExtra).toBeUndefined();
        expect(secondExtra).toEqual("added");
      });
    });
  });
}

runFuncTests(() => new MemorySaverAssertImmutable());
