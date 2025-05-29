import { z } from "zod";
import { Command } from "../constants.js";
import { Annotation } from "../graph/annotation.js";
import {
  MessagesAnnotation,
  MessagesZodState,
} from "../graph/messages_annotation.js";
import { StateGraph, typedNode } from "../graph/state.js";
import { _AnyIdHumanMessage } from "./utils.js";

it("Annotation.Root", async () => {
  const StateAnnotation = Annotation.Root({
    messages: MessagesAnnotation.spec.messages,
    foo: Annotation<string>,
  });

  const node = typedNode(StateAnnotation, {
    nodes: ["nodeA", "nodeB", "nodeC"],
  });

  const nodeA = node(
    (state) => {
      const goto = state.foo === "foo" ? "nodeB" : "nodeC";
      return new Command({
        update: { messages: [{ type: "user", content: "a" }], foo: "a" },
        goto,
      });
    },
    { ends: ["nodeB", "nodeC"] }
  );

  const nodeB = node(() => {
    return new Command({
      goto: "nodeC",
      update: { foo: "123" },
    });
  });
  const nodeC = node((state) => ({ foo: `${state.foo}|c` }));

  const graph = new StateGraph(StateAnnotation)
    .addNode({ nodeA, nodeB, nodeC })
    .addEdge("__start__", "nodeA")
    .compile();

  expect(await graph.invoke({ foo: "foo" })).toEqual({
    messages: [new _AnyIdHumanMessage("a")],
    foo: "123|c",
  });
});

it("Zod", async () => {
  const StateAnnotation = MessagesZodState.extend({
    foo: z.string(),
  });

  const node = typedNode(StateAnnotation, {
    nodes: ["nodeA", "nodeB", "nodeC"],
  });

  const nodeA = node(
    (state) => {
      const goto = state.foo === "foo" ? "nodeB" : "nodeC";
      return new Command({
        update: { messages: [{ type: "user", content: "a" }], foo: "a" },
        goto,
      });
    },
    { ends: ["nodeB", "nodeC"] }
  );

  const nodeB = node(() => {
    return new Command({
      goto: "nodeC",
      update: { foo: "123" },
    });
  });

  const nodeC = node((state) => ({ foo: `${state.foo}|c` }));

  const graph = new StateGraph(StateAnnotation)
    .addNode({ nodeA, nodeB, nodeC })
    .addEdge("__start__", "nodeA")
    .compile();

  expect(await graph.invoke({ foo: "foo" })).toEqual({
    messages: [new _AnyIdHumanMessage("a")],
    foo: "123|c",
  });
});
