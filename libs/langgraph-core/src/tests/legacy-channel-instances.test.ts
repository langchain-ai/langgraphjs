import { expect, it } from "vitest";
import { Annotation, END, START, StateGraph } from "../web.js";
import type { StateGraphArgs } from "../graph/state.js";
import { LastValue } from "../channels/last_value.js";
import { Topic } from "../channels/topic.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";

it.each([
  new LastValue<string>(),
  new Topic<string>(),
  new BinaryOperatorAggregate<string[], string[]>(
    (a, b) => a.concat(b),
    () => []
  ),
])(
  "rejects a channel instance in legacy reducer descriptors: %s",
  (channel) => {
    const args = { channels: { value: channel } } as unknown as StateGraphArgs<{
      value: string;
    }>;
    expect(() => new StateGraph(args)).toThrow(
      /channel instance.*value.*channels/i
    );
  }
);

it("still supports legacy reducer descriptors", async () => {
  const graph = new StateGraph<{ value: string }>({ channels: { value: null } })
    .addNode("update", () => ({ value: "new" }))
    .addEdge(START, "update")
    .addEdge("update", END)
    .compile();
  await expect(graph.invoke({ value: "old" })).resolves.toEqual({
    value: "new",
  });
});

it("still accepts channel instances in Annotation.Root", async () => {
  const state = Annotation.Root({ value: new LastValue<string>() });
  const graph = new StateGraph(state)
    .addNode("update", () => ({ value: "new" }))
    .addEdge(START, "update")
    .addEdge("update", END)
    .compile();
  await expect(graph.invoke({ value: "old" })).resolves.toEqual({
    value: "new",
  });
});
