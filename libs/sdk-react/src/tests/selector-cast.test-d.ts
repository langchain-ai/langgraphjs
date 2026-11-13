/**
 * Reproduction: a fully-typed `UseStreamReturn<typeof agent>` handle
 * should flow into the selector hooks (`useMessages`, `useToolCalls`,
 * `useValues`) and into the public `AnyStream` escape-hatch type
 * WITHOUT an `as AnyStream` cast.
 */
import { describe, expectTypeOf, test } from "vitest";
import { createDeepAgent } from "deepagents";

import {
  useStream,
  useMessages,
  useToolCalls,
  useValues,
  type AnyStream,
  type UseStreamReturn,
} from "../index.js";

const agent = createDeepAgent({
  tools: [],
  subagents: [
    { name: "researcher", description: "r", systemPrompt: "r" },
  ],
});

describe("selector hooks accept concrete stream without cast", () => {
  test("useMessages / useToolCalls / useValues", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });

    useMessages(stream);
    useToolCalls(stream);
    useValues(stream);

    const snapshot = [...stream.subagents.values()][0];
    useMessages(stream, snapshot);
    useToolCalls(stream, snapshot);
  });

  test("subagents are keyed by their task tool call id", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });

    expectTypeOf(stream.subagents.get).parameter(0).toEqualTypeOf<string>();
  });

  test("concrete handle is assignable to AnyStream", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });
    const erased: AnyStream = stream;
    useMessages(erased);
  });

  test("wrapper typed against UseStreamReturn flows in too", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });
    const handle: UseStreamReturn<typeof agent> = stream;
    useToolCalls(handle);
  });
});
