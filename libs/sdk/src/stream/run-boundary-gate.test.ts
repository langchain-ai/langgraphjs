import { describe, expect, it } from "vitest";
import type { Event, LifecycleEvent, ValuesEvent } from "@langchain/protocol";

import {
  extractEventRunId,
  RunBoundaryGate,
} from "./run-boundary-gate.js";

function lifecycleEvent(
  status: string,
  opts: { run_id?: string; event_id?: string; seq?: number } = {}
): Event {
  return {
    type: "event",
    method: "lifecycle",
    seq: opts.seq ?? 1,
    ...(opts.run_id != null ? { run_id: opts.run_id } : {}),
    ...(opts.event_id != null ? { event_id: opts.event_id } : {}),
    params: {
      namespace: [],
      timestamp: 0,
      data: { event: status },
    },
  } as LifecycleEvent & Event;
}

function valuesEvent(
  opts: { run_id?: string; event_id?: string; title?: string } = {}
): Event {
  return {
    type: "event",
    method: "values",
    seq: 1,
    ...(opts.run_id != null ? { run_id: opts.run_id } : {}),
    ...(opts.event_id != null ? { event_id: opts.event_id } : {}),
    params: {
      namespace: [],
      timestamp: 0,
      data: { title: opts.title ?? "x", messages: [] },
    },
  } as ValuesEvent & Event;
}

describe("extractEventRunId", () => {
  it("prefers envelope run_id", () => {
    expect(
      extractEventRunId({
        run_id: "run-a",
        event_id: "synth:run-b:lc||completed",
      })
    ).toBe("run-a");
  });

  it("falls back to synth event_id prefix", () => {
    expect(
      extractEventRunId({ event_id: "synth:run-old:lc||completed" })
    ).toBe("run-old");
  });

  it("returns undefined for opaque event ids", () => {
    expect(extractEventRunId({ event_id: "1-2" })).toBeUndefined();
  });
});

describe("RunBoundaryGate", () => {
  it("accepts everything while idle", () => {
    const gate = new RunBoundaryGate();
    expect(gate.acceptLifecycle(lifecycleEvent("completed", { run_id: "x" }))).toBe(
      true
    );
    expect(gate.acceptValues(valuesEvent({ run_id: "x" }))).toBe(true);
  });

  it("buffers matching terminals until bind and rejects other runs", () => {
    const gate = new RunBoundaryGate();
    gate.onSubmitStart();
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", {
          run_id: "run-old",
          event_id: "e-old",
        })
      )
    ).toBe(false);
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", {
          run_id: "run-current",
          event_id: "e-cur",
        })
      )
    ).toBe(false);

    const flush = gate.onRunBound("run-current");
    expect(flush.terminals.map((e) => e.event_id)).toEqual(["e-cur"]);
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", { run_id: "run-old", event_id: "e2" })
      )
    ).toBe(false);
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", {
          run_id: "run-current",
          event_id: "e3",
        })
      )
    ).toBe(true);
  });

  it("rejects values from other runs after bind", () => {
    const gate = new RunBoundaryGate();
    gate.onSubmitStart();
    gate.onRunBound("run-current");
    expect(gate.acceptValues(valuesEvent({ run_id: "run-old" }))).toBe(false);
    expect(gate.acceptValues(valuesEvent({ run_id: "run-current" }))).toBe(
      true
    );
  });

  it("legacy path requires running after bind before terminals", () => {
    const gate = new RunBoundaryGate();
    gate.onSubmitStart();
    gate.onRunBound("run-current");
    expect(gate.acceptLifecycle(lifecycleEvent("completed"))).toBe(false);
    expect(gate.acceptLifecycle(lifecycleEvent("running"))).toBe(true);
    expect(gate.acceptLifecycle(lifecycleEvent("completed"))).toBe(true);
  });

  it("resume mode ignores interrupted until running but accepts failed", () => {
    const gate = new RunBoundaryGate();
    gate.onResumeStart();
    expect(gate.acceptLifecycle(lifecycleEvent("interrupted"))).toBe(false);
    expect(gate.acceptLifecycle(lifecycleEvent("failed"))).toBe(true);
    expect(gate.acceptLifecycle(lifecycleEvent("running"))).toBe(true);
    expect(gate.acceptLifecycle(lifecycleEvent("interrupted"))).toBe(true);
  });

  it("uses synth event_id when envelope run_id is absent", () => {
    const gate = new RunBoundaryGate();
    gate.onSubmitStart();
    gate.onRunBound("run-current");
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", {
          event_id: "synth:run-old:lc||completed",
        })
      )
    ).toBe(false);
    expect(
      gate.acceptLifecycle(
        lifecycleEvent("completed", {
          event_id: "synth:run-current:lc||completed",
        })
      )
    ).toBe(true);
  });
});
