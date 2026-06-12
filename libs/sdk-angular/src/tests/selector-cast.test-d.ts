/**
 * Reproduction: a fully-typed `UseStreamReturn<typeof agent>` handle
 * should flow into the selector primitives (`injectMessages`,
 * `injectToolCalls`, `injectValues`) and into the public `AnyStream`
 * escape-hatch type WITHOUT an `as AnyStream` cast.
 */
import { describe, test } from "vitest";
import { createDeepAgent } from "deepagents";

import {
  useStream,
  injectMessages,
  injectToolCalls,
  injectValues,
  type AnyStream,
  type UseStreamReturn,
} from "../index.js";

const agent = createDeepAgent({
  tools: [],
  subagents: [{ name: "researcher", description: "r", systemPrompt: "r" }],
});

describe("selector primitives accept concrete stream without cast", () => {
  test("injectMessages / injectToolCalls / injectValues at root", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });

    injectMessages(stream);
    injectToolCalls(stream);
    injectValues(stream);
  });

  test("concrete handle is assignable to AnyStream", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });
    const erased: AnyStream = stream;
    injectMessages(erased);
  });

  test("wrapper typed against UseStreamReturn flows in too", () => {
    const stream = useStream<typeof agent>({ assistantId: "deep-agent" });
    const handle: UseStreamReturn<typeof agent> = stream;
    injectToolCalls(handle);
  });
});
