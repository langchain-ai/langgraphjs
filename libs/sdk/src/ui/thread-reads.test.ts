import { describe, expect, it } from "vitest";
import type { ThreadState } from "../schema.js";
import {
  applyStopRead,
  hasPendingNodes,
  hasTaskErrors,
  hasTaskInterrupts,
  planReadAfterRun,
  planStopRead,
} from "./thread-reads.js";

const head = (extra: Record<string, unknown> = {}) =>
  ({
    values: {},
    next: [],
    tasks: [],
    checkpoint: {
      thread_id: "t1",
      checkpoint_id: "cp1",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    metadata: undefined,
    created_at: null,
    parent_checkpoint: null,
    ...extra,
  }) as unknown as ThreadState;

const task = (extra: Record<string, unknown>) => ({
  id: "task-1",
  name: "agent",
  error: null,
  interrupts: [],
  ...extra,
});

const heads = {
  "no head": undefined,
  "a plain head": head(),
  "a head without next or tasks": head({ next: undefined, tasks: undefined }),
  "a pending node": head({ next: ["review"] }),
  "a task interrupt": head({
    tasks: [task({ interrupts: [{ id: "int-1", value: "approve?" }] })],
  }),
  "a task error": head({ tasks: [task({ error: "boom" })] }),
};

describe("thread state checks", () => {
  it.each([
    { shown: "no head", pending: false, interrupts: false, errors: false },
    { shown: "a plain head", pending: false, interrupts: false, errors: false },
    {
      shown: "a head without next or tasks",
      pending: false,
      interrupts: false,
      errors: false,
    },
    {
      shown: "a pending node",
      pending: true,
      interrupts: false,
      errors: false,
    },
    {
      shown: "a task interrupt",
      pending: false,
      interrupts: true,
      errors: false,
    },
    { shown: "a task error", pending: false, interrupts: false, errors: true },
  ] as const)("$shown", ({ shown, pending, interrupts, errors }) => {
    expect(hasPendingNodes(heads[shown])).toBe(pending);
    expect(hasTaskInterrupts(heads[shown])).toBe(interrupts);
    expect(hasTaskErrors(heads[shown])).toBe(errors);
  });
});

describe("planReadAfterRun", () => {
  const loud = { quiet: false, wait: true };
  const quietWait = { quiet: true, wait: true };
  const quietLate = { quiet: true, wait: false };

  it.each([
    { shown: "no head", refetch: true, values: true, plan: loud },
    { shown: "a plain head", refetch: true, values: true, plan: loud },
    { shown: "a task interrupt", refetch: true, values: true, plan: loud },
    { shown: "a plain head", refetch: true, values: false, plan: loud },
    { shown: "no head", refetch: false, values: true, plan: undefined },
    { shown: "a plain head", refetch: false, values: true, plan: undefined },
    {
      shown: "a head without next or tasks",
      refetch: false,
      values: true,
      plan: undefined,
    },
    { shown: "a pending node", refetch: false, values: true, plan: quietWait },
    { shown: "a task interrupt", refetch: false, values: true, plan: quietWait },
    { shown: "a task error", refetch: false, values: true, plan: quietWait },
    { shown: "no head", refetch: false, values: false, plan: quietLate },
    { shown: "a plain head", refetch: false, values: false, plan: quietLate },
    { shown: "a pending node", refetch: false, values: false, plan: quietWait },
    { shown: "a task interrupt", refetch: false, values: false, plan: quietWait },
    { shown: "a task error", refetch: false, values: false, plan: quietWait },
  ] as const)(
    "after a run on $shown (refetch: $refetch, streamed values: $values)",
    ({ shown, refetch, values, plan }) => {
      expect(planReadAfterRun(heads[shown], refetch, values)).toEqual(plan);
    }
  );

  it.each([
    { shown: "no head", values: false, plan: quietWait },
    { shown: "a plain head", values: false, plan: quietWait },
    { shown: "a plain head", values: true, plan: undefined },
  ] as const)(
    "after a run on $shown with a run queued behind it (streamed values: $values)",
    ({ shown, values, plan }) => {
      expect(planReadAfterRun(heads[shown], false, values, true)).toEqual(plan);
    }
  );
});

describe("planStopRead", () => {
  it.each([
    { label: "history", stop: { history: true }, plan: { quiet: false } },
    {
      label: "history and a user thread",
      stop: { history: true, userThread: true },
      plan: { quiet: false },
    },
    { label: "no history", stop: { history: false }, plan: { quiet: true } },
    {
      label: "no history and a user thread",
      stop: { history: false, userThread: true },
      plan: undefined,
    },
  ])("with $label", ({ stop, plan }) => {
    expect(planStopRead(stop)).toEqual(plan);
  });
});

describe("applyStopRead", () => {
  const cancelled = task({
    id: "task-2",
    name: "agent",
    error: "CancelledError()",
  });
  const oldError = task({ id: "task-1", error: "boom" });
  const shownStates = {
    "a plain head": head(),
    "a breakpoint it continued from": head({ next: ["agent"] }),
    "an interrupt the run answered": heads["a task interrupt"],
    "an error from before the run": head({
      next: ["agent"],
      tasks: [oldError],
    }),
  };

  it.each([
    {
      label: "drops the error and step of a cancelled task",
      shown: "a plain head",
      read: head({ next: ["agent"], tasks: [cancelled] }),
      kept: head({ next: [], tasks: [{ ...cancelled, error: null }] }),
    },
    {
      label: "shows no breakpoint after continuing from one",
      shown: "a breakpoint it continued from",
      read: head({ next: ["agent"], tasks: [cancelled] }),
      kept: head({ next: [], tasks: [{ ...cancelled, error: null }] }),
    },
    {
      label: "shows no breakpoint after answering an interrupt",
      shown: "an interrupt the run answered",
      read: head({ next: ["agent"], tasks: [cancelled] }),
      kept: head({ next: [], tasks: [{ ...cancelled, error: null }] }),
    },
    {
      label: "keeps a breakpoint the stop cancelled nothing at",
      shown: "a breakpoint it continued from",
      read: head({ next: ["agent"] }),
      kept: head({ next: ["agent"] }),
    },
    {
      label: "keeps an error the shown head had",
      shown: "an error from before the run",
      read: head({ next: ["agent"], tasks: [oldError] }),
      kept: head({ next: ["agent"], tasks: [oldError] }),
    },
    {
      label: "keeps an old error next to a cancelled task",
      shown: "an error from before the run",
      read: head({ next: ["agent"], tasks: [oldError, cancelled] }),
      kept: head({
        next: [],
        tasks: [oldError, { ...cancelled, error: null }],
      }),
    },
  ] as const)("$label", ({ shown, read, kept }) => {
    const older = head({ tasks: [task({ id: "task-0", error: "old" })] });

    expect(applyStopRead([read, older], shownStates[shown])).toEqual([
      kept,
      older,
    ]);
  });

  it("reads no head", () => {
    expect(applyStopRead([], head())).toEqual([]);
  });
});
