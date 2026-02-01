import { describe, test, expectTypeOf } from "vitest";
import type { ComputedRef } from "vue";
import type { AIMessage, Message } from "../types.messages.js";
import { useStream } from "../vue/index.js";
import type {
  UseStream,
  UseStreamCustom,
  UseStreamTransport,
} from "../vue/index.js";

describe("vue/useStream typing", () => {
  test("overload: custom transport returns UseStreamCustom", () => {
    type State = { messages: string[] };
    const stream = useStream<State>({
      transport: {} as UseStreamTransport<State>,
      throttle: false,
    });

    expectTypeOf(stream).toMatchTypeOf<UseStreamCustom<State>>();
    expectTypeOf(stream.values).toMatchTypeOf<ComputedRef<State>>();
  });

  test("overload: LGP returns UseStream", () => {
    type ToolCalls = { name: "t"; args: { x: string }; id?: string };
    type State = { messages: Message<ToolCalls>[] };

    const stream = useStream<State>({
      assistantId: "a1",
      apiUrl: "http://localhost:2024",
      throttle: false,
    });

    expectTypeOf(stream).toMatchTypeOf<UseStream<State>>();
    expectTypeOf(stream.isLoading).toMatchTypeOf<ComputedRef<boolean>>();
    expectTypeOf(stream.messages).toMatchTypeOf<
      ComputedRef<Message<ToolCalls>[]>
    >();

    // getToolCalls param is AIMessage<ToolCalls>
    type Param0 = Parameters<typeof stream.getToolCalls>[0];
    expectTypeOf<Param0>().toEqualTypeOf<AIMessage<ToolCalls>>();
  });
});
