import { expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { StateGraph } from "../index.js";

it("preserves node input inference when a trace policy is provided", () => {
  new StateGraph(z.object({ value: z.number(), extra: z.string() })).addNode(
    "node",
    (state) => {
      expectTypeOf(state).toEqualTypeOf<{ value: number }>();
      return { value: state.value + 1 };
    },
    {
      input: z.object({ value: z.number() }),
      tracePolicy: {
        processInputs: (inputs) => {
          expectTypeOf(inputs).toBeObject();
          return {};
        },
      },
    }
  );
});
