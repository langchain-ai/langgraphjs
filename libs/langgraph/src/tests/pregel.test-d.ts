/* eslint-disable @typescript-eslint/no-explicit-any */
import "../graph/zod/plugin.js";
import { z } from "zod";

import { expectTypeOf, it, beforeAll } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { gatherIterator } from "../utils.js";
import { StreamMode } from "../pregel/types.js";
import { task, entrypoint } from "../func/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { INTERRUPT, isInterrupted } from "../constants.js";

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
      one: () => ({ foo: "one" }),
      two: () => ({ foo: "two" }),
      three: () => ({ foo: "three" }),
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
    Record<"one" | "two" | "three", { foo?: string[] | string }>[]
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
  ).toExtend<Record<"one" | "two" | "three", { foo?: string[] | string }>[]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["updates"] }))
  ).toExtend<
    ["updates", Record<"one" | "two" | "three", { foo?: string[] | string }>][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates"], subgraphs: true })
    )
  ).toExtend<
    [
      string[],
      "updates",
      Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
        ]
      | ["values", { foo: string[] }]
      | ["debug", Record<string, any>]
      | ["messages", [BaseMessage, Record<string, any>]]
      | ["custom", any]
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
        ]
      | [string[], "values", { foo: string[] }]
      | [string[], "debug", Record<string, any>]
      | [string[], "messages", [BaseMessage, Record<string, any>]]
      | [string[], "custom", any]
    )[]
  >();
});

it("state graph zod", async () => {
  const state = z.object({
    foo: z.array(z.string()).langgraph.reducer((state, update) => {
      return Array.isArray(update) ? [...state, ...update] : [...state, update];
    }, z.union([z.string(), z.array(z.string())])),
  });

  const graph = new StateGraph(state)
    .addSequence({
      one: () => ({ foo: "one" }),
      two: () => ({ foo: "two" }),
      three: () => ({ foo: "three" }),
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
    Record<"one" | "two" | "three", { foo?: string[] | string }>[]
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
  ).toExtend<Record<"one" | "two" | "three", { foo?: string[] | string }>[]>();

  expectTypeOf(
    await gatherIterator(graph.stream(input, { streamMode: ["updates"] }))
  ).toExtend<
    ["updates", Record<"one" | "two" | "three", { foo?: string[] | string }>][]
  >();

  expectTypeOf(
    await gatherIterator(
      graph.stream(input, { streamMode: ["updates"], subgraphs: true })
    )
  ).toExtend<
    [
      string[],
      "updates",
      Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
        ]
      | ["values", { foo: string[] }]
      | ["debug", Record<string, any>]
      | ["messages", [BaseMessage, Record<string, any>]]
      | ["custom", any]
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
          Record<"one" | "two" | "three", { foo?: string[] | string }>
        ]
      | [string[], "values", { foo: string[] }]
      | [string[], "debug", Record<string, any>]
      | [string[], "messages", [BaseMessage, Record<string, any>]]
      | [string[], "custom", any]
    )[]
  >();
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
