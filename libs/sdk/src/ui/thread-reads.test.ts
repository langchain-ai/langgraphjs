import { describe, expect, it } from "vitest";
import type { ThreadState } from "../schema.js";
import {
  hasPendingNodes,
  hasTaskErrors,
  hasTaskInterrupts,
  planReadAfterRun,
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
  it.each([
    { shown: "no head", refetch: true, plan: { quiet: false } },
    { shown: "a plain head", refetch: true, plan: { quiet: false } },
    { shown: "a task interrupt", refetch: true, plan: { quiet: false } },
    { shown: "no head", refetch: false, plan: undefined },
    { shown: "a plain head", refetch: false, plan: undefined },
    { shown: "a head without next or tasks", refetch: false, plan: undefined },
    { shown: "a pending node", refetch: false, plan: { quiet: true } },
    { shown: "a task interrupt", refetch: false, plan: { quiet: true } },
    { shown: "a task error", refetch: false, plan: { quiet: true } },
  ] as const)(
    "after a run on $shown (refetch: $refetch)",
    ({ shown, refetch, plan }) => {
      expect(planReadAfterRun(heads[shown], refetch)).toEqual(plan);
    }
  );
});
