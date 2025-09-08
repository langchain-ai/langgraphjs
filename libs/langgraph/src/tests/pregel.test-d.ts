/* eslint-disable @typescript-eslint/no-explicit-any */
import "../graph/zod/plugin.js";
import { z } from "zod/v3";
import { z as z4 } from "zod/v4";

import { expectTypeOf, it, beforeAll, expect } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { gatherIterator } from "../utils.js";
import { StreamMode } from "../pregel/types.js";
import { task, entrypoint } from "../func/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { Command, END, INTERRUPT, isInterrupted, START } from "../constants.js";
import { withLangGraph } from "../graph/zod/meta.js";
import { Runtime } from "../pregel/runnable_types.js";
import { registry } from "../graph/zod/zod-registry.js";
import { MessagesZodMeta } from "../graph/messages_annotation.js";
import { writer } from "../writer.js";
import { interrupt } from "../interrupt.js";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

beforeAll(() => {
  // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
  initializeAsyncLocalStorageSingleton();
});

it("state graph annotation", async () => {
  const state = Annotation.Root({
    foo: Annotation({
      reducer: (state: string[], update: string | string[]) => {
        return Array.isArray(update)
          ? [...state, ...update]
          : [...state, update];
      },
      default: () => [],
    }),
  });

  const graph = new StateGraph(state)
    .addSequence({
      one: () => ({ foo: "one" as const }),
      two: () => ({ foo: "two" as const }),
      three: () => ({ foo: "three" as const }),
    })
    .addEdge("__start__", "one")
    .compile();

  const input = { foo: "bar" };

  const values = await graph.invoke(input);
  expectTypeOf(values).toExtend<{ foo: string[] }>();

  if (isInterrupted<string>(values)) {
    expectTypeOf(values[INTERRUPT][0].value).toExtend<string | undefined>();
  }

  expectTypeOf(await gatherIterator(graph.stream(input))).toExtend<
    { one?: { foo: "one" }; two?: { foo: "two" }; three?: { foo: "three" } }[]
  >();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: "values" }))
  ).toExtend<{ foo: string[] }[]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["values"] }))
  ).toExtend<["values", { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: "values", subgraphs: true })
    )
  ).toExtend<[string[], { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["values"],
        subgraphs: true,
      })
    )
  ).toExtend<[string[], "values", { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: "updates" }))
  ).toExtend<
    {
      one?: { foo: "one" };
      two?: { foo: "two" };
      three?: { foo: "three" };
    }[]
  >();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["updates"] }))
  ).toExtend<
    [
      "updates",
      {
        one?: { foo: "one" };
        two?: { foo: "two" };
        three?: { foo: "three" };
      }
    ][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates"],
        subgraphs: true,
      })
    )
  ).toExtend<
    [
      string[],
      "updates",
      {
        one?: { foo: "one" };
        two?: { foo: "two" };
        three?: { foo: "three" };
      }
    ][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates", "values"] })
    )
  ).toExtend<
    (
      | [
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | ["values", { foo: string[] }]
    )[]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"],
        subgraphs: true,
      })
    )
  ).toExtend<
    (
      | [
          string[],
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | [string[], "values", { foo: string[] }]
    )[]
  >();

  // generic union
  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"] as
          | StreamMode
          | StreamMode[]
          | undefined,
      })
    )
  ).toExtend<
    (
      | [
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | ["values", { foo: string[] }]
      | ["debug", Record<string, any>]
      | ["messages", [BaseMessage, Record<string, any>]]
      | ["custom", any]
      | ["checkpoints", { values: { foo: string[] } }]
      | [
          "tasks",
          { id: string; name: string } & (
            | { input: unknown }
            | { result: [string, unknown][] }
          )
        ]
    )[]
  >();
});

it("state graph configurable", async () => {
  const graph = new StateGraph(
    Annotation.Root({
      foo: Annotation({
        reducer: (state: string[], update: string | string[]) => {
          return Array.isArray(update)
            ? [...state, ...update]
            : [...state, update];
        },
        default: () => [],
      }),
    }),
    Annotation.Root({ modelName: Annotation<string> })
  )
    .addNode("one", (state, config) => {
      expectTypeOf(state).toExtend<{ foo: string[] }>();
      expectTypeOf(config.configurable).toExtend<
        { modelName: string } | undefined
      >();

      return { foo: "one" };
    })
    .addEdge(START, "one")
    .compile();

  await graph.invoke({ foo: "bar" }, { configurable: { modelName: "valid" } });

  // @ts-expect-error - Invalid configurable value
  await graph.invoke({ foo: "bar" }, { configurable: { modelName: 123 } });

  const graphZod = new StateGraph(
    z.object({
      foo: withLangGraph(z.array(z.string()), {
        reducer: {
          schema: z.union([z.string(), z.array(z.string())]),
          fn: (state: string[], update: string | string[]) => {
            return Array.isArray(update)
              ? [...state, ...update]
              : [...state, update];
          },
        },
      }),
    }),
    z.object({ modelName: z.string() })
  )
    .addNode("one", (state, runtime) => {
      expectTypeOf(state).toExtend<{ foo: string[] }>();
      expectTypeOf(runtime.configurable).toExtend<
        { modelName: string } | undefined
      >();

      return { foo: "one" };
    })
    .addEdge(START, "one")
    .compile();

  await graphZod.stream(
    { foo: "bar" },
    { streamMode: "custom", configurable: { modelName: "valid" } }
  );

  await expect(
    // @ts-expect-error - Invalid configurable value
    graphZod.invoke({ foo: "bar" }, { configurable: { modelName: 123 } })
  ).rejects.toThrow("Expected string, received number");
});

it("state graph context", async () => {
  const graph = new StateGraph(
    Annotation.Root({
      foo: Annotation({
        reducer: (state: string[], update: string | string[]) => {
          return Array.isArray(update)
            ? [...state, ...update]
            : [...state, update];
        },
        default: () => [],
      }),
    }),
    Annotation.Root({ modelName: Annotation<string> })
  )
    .addNode("one", (state, runtime: Runtime<{ modelName: string }>) => {
      expectTypeOf(state).toExtend<{ foo: string[] }>();
      expectTypeOf(runtime.context).toExtend<
        { modelName: string } | undefined
      >();
      return { foo: "one" };
    })
    .addEdge(START, "one")
    .compile();

  await graph.invoke({ foo: "bar" }, { context: { modelName: "valid" } });

  // @ts-expect-error - Invalid context value, but only checked at type-level
  await graph.invoke({ foo: "bar" }, { context: { modelName: 123 } });

  const graphZod = new StateGraph(
    z.object({
      foo: withLangGraph(z.array(z.string()), {
        reducer: {
          schema: z.union([z.string(), z.array(z.string())]),
          fn: (state: string[], update: string | string[]) => {
            return Array.isArray(update)
              ? [...state, ...update]
              : [...state, update];
          },
        },
      }),
    }),
    z.object({ modelName: z.string() })
  )
    .addNode("one", (state, runtime) => {
      expectTypeOf(state).toExtend<{ foo: string[] }>();
      expectTypeOf(runtime.context).toExtend<
        { modelName: string } | undefined
      >();
      expect(runtime.context?.modelName).toBeTypeOf("string");

      return { foo: "one" };
    })
    .addEdge(START, "one")
    .compile();

  await graphZod.stream(
    { foo: "bar" },
    { streamMode: "custom", context: { modelName: "valid" } }
  );

  await expect(
    // @ts-expect-error - Invalid context value
    graphZod.invoke({ foo: "bar" }, { context: { modelName: 123 } })
  ).rejects.toThrow("Expected string, received number");
});

it("state graph zod", async () => {
  const state = z.object({
    foo: z.array(z.string()).langgraph.reducer((state, update) => {
      return Array.isArray(update) ? [...state, ...update] : [...state, update];
    }, z.union([z.string(), z.array(z.string())])),
  });

  const graph = new StateGraph(state)
    .addSequence({
      one: () => ({ foo: "one" as const }),
      two: () => ({ foo: "two" as const }),
      three: () => ({ foo: "three" as const }),
    })
    .addEdge("__start__", "one")
    .compile();

  const input = { foo: "bar" };

  const values = await graph.invoke(input);
  expectTypeOf(values).toExtend<{ foo: string[] }>();

  if (isInterrupted<string>(values)) {
    expectTypeOf(values[INTERRUPT][0].value).toExtend<string | undefined>();
  }

  expectTypeOf(await gatherIterator(graph.stream(input))).toExtend<
    { one?: { foo: "one" }; two?: { foo: "two" }; three?: { foo: "three" } }[]
  >();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: "values" }))
  ).toExtend<{ foo: string[] }[]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["values"] }))
  ).toExtend<["values", { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: "values", subgraphs: true })
    )
  ).toExtend<[string[], { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["values"], subgraphs: true })
    )
  ).toExtend<[string[], "values", { foo: string[] }][]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: "updates" }))
  ).toExtend<
    { one?: { foo: "one" }; two?: { foo: "two" }; three?: { foo: "three" } }[]
  >();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["updates"] }))
  ).toExtend<
    [
      "updates",
      { one?: { foo: "one" }; two?: { foo: "two" }; three?: { foo: "three" } }
    ][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates"], subgraphs: true })
    )
  ).toExtend<
    [
      string[],
      "updates",
      { one?: { foo: "one" }; two?: { foo: "two" }; three?: { foo: "three" } }
    ][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates", "values"] })
    )
  ).toExtend<
    (
      | [
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | ["values", { foo: string[] }]
    )[]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"],
        subgraphs: true,
      })
    )
  ).toExtend<
    (
      | [
          string[],
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | [string[], "values", { foo: string[] }]
    )[]
  >();

  // generic union
  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"] as
          | StreamMode
          | StreamMode[]
          | undefined,
      })
    )
  ).toExtend<
    (
      | [
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | ["values", { foo: string[] }]
      | ["debug", Record<string, any>]
      | ["messages", [BaseMessage, Record<string, any>]]
      | ["custom", any]
      | ["checkpoints", { values: { foo: string[] } }]
      | [
          "tasks",
          { id: string; name: string } & (
            | { input: unknown }
            | { result: [string, unknown][] }
          )
        ]
    )[]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"] as
          | StreamMode
          | StreamMode[]
          | undefined,
        subgraphs: true,
      })
    )
  ).toExtend<
    (
      | [
          string[],
          "updates",
          {
            one?: { foo: "one" };
            two?: { foo: "two" };
            three?: { foo: "three" };
          }
        ]
      | [string[], "values", { foo: string[] }]
      | [string[], "debug", Record<string, any>]
      | [string[], "messages", [BaseMessage, Record<string, any>]]
      | [string[], "custom", any]
      | [string[], "checkpoints", { values: { foo: string[] } }]
      | [
          string[],
          "tasks",
          { id: string; name: string } & (
            | { input: unknown }
            | { result: [string, unknown][] }
          )
        ]
    )[]
  >();
});

it("state graph builder", async () => {
  const checkpointer = new MemorySaver();
  const builder = new StateGraph(
    z4.object({
      messages: z4.custom<BaseMessage[]>().register(registry, MessagesZodMeta),
      innerReason: z4.string(),
    }),
    {
      input: z4.object({
        messages: z4
          .custom<BaseMessage[]>()
          .register(registry, MessagesZodMeta),
      }),

      writer: writer<{ custom: string }>,
      interrupt: interrupt<{ reason: string }, { messages: string[] }>,

      // Allow optionally specifying all nodes upfront.
      // This is needed to properly type `goto` commands and removes
      // friction when dynamically constructing graphs.
      nodes: ["hello", "what"],
    }
  );

  const hello: typeof builder.Node = async (_, runtime) => {
    // @ts-expect-error - Invalid interrupt input
    if (false) runtime.interrupt?.({ reason: false });

    // @ts-expect-error - Invalid writer input
    if (false) runtime.interrupt?.();

    const result = runtime.interrupt?.({ reason: "hello" });

    if (result != null) {
      runtime.writer?.({ custom: "hello" });

      // @ts-expect-error - Invalid writer value
      if (false) runtime.writer?.({ invalid: "hello" });

      // @ts-expect-error - Invalid interrupt value
      if (false) runtime.writer?.();

      return new Command({
        update: { messages: result.messages },
        goto: "what",
      });
    }

    return new Command({ goto: "what" });
  };

  const what: typeof builder.Node = async (_, runtime) => {
    const result = runtime.interrupt?.({ reason: "what" });
    if (result != null) return { messages: result.messages };
    return {};
  };

  if (false) {
    // @ts-expect-error - Invalid goto value
    const invalidGoto: typeof builder.Node = async () => {
      return new Command({ goto: "invalid" });
    };
  }

  builder.addNode("hello", hello, { ends: [END, "what"] });
  builder.addNode("what", what);
  builder.addEdge(START, "hello");

  const graph = builder.compile({ checkpointer });

  const thread = graph.withConfig({ configurable: { thread_id: "1" } });
  const first = await thread.invoke({ messages: "input" });

  expect(first).toMatchObject({
    messages: [{ text: "input" }],
    __interrupt__: [{ id: expect.any(String), value: { reason: "hello" } }],
  });

  if (graph.isInterrupted(first)) {
    expectTypeOf(first.__interrupt__).toExtend<
      { id?: string; value?: { reason: string } }[]
    >();
  }

  // @ts-expect-error - Invalid goto value
  if (false) thread.invoke(new Command({ goto: "xxx" }));

  // @ts-expect-error - Invalid update value
  if (false) thread.invoke(new Command({ update: { messages: true } }));

  const second = await gatherIterator(
    thread.stream(new Command({ resume: { messages: ["resume: hello"] } }), {
      streamMode: ["values", "custom"],
    })
  );

  expect(second).toMatchObject([
    ["values", { messages: [{ text: "input" }] }],
    ["custom", { custom: "hello" }],
    ["values", { messages: [{ text: "input" }, { text: "resume: hello" }] }],
    [
      "values",
      {
        __interrupt__: [{ id: expect.any(String), value: { reason: "what" } }],
      },
    ],
  ]);

  for await (const [mode, value] of second) {
    if (mode === "values") {
      if (graph.isInterrupted(value)) {
        expectTypeOf(value.__interrupt__).toExtend<
          { id?: string; value?: { reason: string } }[]
        >();
      }
    }

    if (mode === "custom") {
      expectTypeOf(value).toExtend<{ custom: string }>();
    }
  }

  const third = await thread.invoke(
    new Command({ resume: { messages: ["resume: what"] } })
  );

  expect(third).toMatchObject({
    messages: [
      { text: "input" },
      { text: "resume: hello" },
      { text: "resume: what" },
    ],
  });
});

it("functional", async () => {
  const one = task("one", (input: string) => ({ one: `one(${input})` }));
  const two = task("two", (input: string) => ({ two: `two(${input})` }));
  const three = task("three", (input: string) => ({
    three: `three(${input})`,
  }));

  const graph = entrypoint("graph", async (query: { input: string }) => {
    return {
      foo: [
        await one(query.input),
        await two(query.input),
        await three(query.input),
      ],
    };
  });

  const input = { input: "test" };

  type UpdateType = Record<string, any>;
  type ValueType = {
    foo: ({ one: string } | { two: string } | { three: string })[];
  };

  expectTypeOf(await graph.invoke(input)).toExtend<ValueType>();
  expectTypeOf(await gatherIterator(graph.stream(input))).toExtend<
    UpdateType[]
  >();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: "values" }))
  ).toExtend<ValueType[]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["values"] }))
  ).toExtend<["values", ValueType][]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates", "values"] })
    )
  ).toExtend<(["updates", UpdateType] | ["values", ValueType])[]>();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, {
        streamMode: ["updates", "values"],
        subgraphs: true,
      })
    )
  ).toExtend<
    ([string[], "updates", UpdateType] | [string[], "values", ValueType])[]
  >();
});
