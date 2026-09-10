import { expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import {
  omitPayload,
  StateGraph,
  type StateGraphAddNodeOptions,
  type TracePolicy,
} from "../index.js";
import {
  omitPayload as omitWebPayload,
  type TracePolicy as WebTracePolicy,
} from "../web.js";

it("exports the same trace policy API from Node and browser entry points", () => {
  expectTypeOf<TracePolicy>().toEqualTypeOf<WebTracePolicy>();
  expectTypeOf(omitPayload).toEqualTypeOf(omitWebPayload);
  expectTypeOf<StateGraphAddNodeOptions["tracePolicy"]>().toEqualTypeOf<
    TracePolicy | undefined
  >();
});

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
        processInputs: (value) => {
          expectTypeOf(value).toBeUnknown();
          return omitPayload(value);
        },
        processOutputs: omitPayload,
      },
    }
  );
});
