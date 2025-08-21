import { expectTypeOf, it } from "vitest";
import { Annotation, StateGraph } from "../graph/index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { START } from "../constants.js";
import { toLangGraphEventStream } from "../ui/stream.js";
import type { SerializedMessage } from "../ui/types.message.js";

it("toLangGraphEventStream", async () => {
  const graph = new StateGraph(
    Annotation.Root({
      messages: MessagesAnnotation.spec.messages,
      foo: Annotation<string>,
    })
  )
    .addNode("one", () => ({
      messages: { role: "ai", content: "one" as const },
    }))
    .addNode("two", () => ({
      messages: { role: "ai", content: "two" as const },
      foo: "foo:two" as const,
    }))
    .addEdge(START, "one")
    .compile();

  const stream = await toLangGraphEventStream<typeof graph>(
    graph.streamEvents({ messages: "input" }, { version: "v2" })
  );

  for await (const { event, data } of stream) {
    if (event === "values") {
      expectTypeOf(data).toExtend<{
        messages: SerializedMessage.AnyMessage[];
        foo: string;
      }>();
    }

    if (event === "updates") {
      expectTypeOf(data).toExtend<{
        one?: { messages: { role: "ai"; content: "one" } };
        two?: { messages: { role: "ai"; content: "two" }; foo: "foo:two" };
      }>();

      expectTypeOf(data).not.toExtend<{ two?: { foo: "invalid" } }>();

      expectTypeOf(data).toExtend<{
        [node: string]: {
          messages?: SerializedMessage.AnyMessage[] | undefined;
          foo?: string | undefined;
        };
      }>();
    }

    if (event === "custom") {
      // TODO: make `writer` type-safe
      expectTypeOf(data).toExtend<unknown>();
    }
  }
});
