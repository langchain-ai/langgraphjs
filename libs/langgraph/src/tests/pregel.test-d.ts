/* eslint-disable @typescript-eslint/no-explicit-any */
import { expectTypeOf, it } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { gatherIterator } from "../utils.js";
import { StreamMode } from "../pregel/types.js";

it("state graph", async () => {
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
