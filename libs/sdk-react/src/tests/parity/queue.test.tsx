import { expect, it } from "vitest";

import { is, v1Bug } from "./differences.js";
import {
  client,
  expectSameSummary,
  onBothSides,
  runsOf,
  summary,
  type Hooks,
  type Side,
  type Summary,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count &&
  runs.every((run) => run.status !== "pending" && run.status !== "running");
const texts = (s: Summary) => s.final.messages.map((m) => m.text);
const oldestFirst = (runs: { status: string; created_at: string }[]) =>
  [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((run) => run.status);

type Queue = ReturnType<Hooks["useSubmissionQueue"]>;

function firstText(values: unknown) {
  const messages = (values as { messages?: { content?: unknown }[] } | null)?.messages;
  return String(messages?.[0]?.content ?? "?");
}

async function mountWithQueue(side: Side, options: Record<string, unknown> = {}) {
  const handle: { queue?: Queue } = {};
  const probe = await side.mount({
    assistantId: "slow_graph",
    options,
    extra: (stream, hooks) => {
      const queue = hooks.useSubmissionQueue(stream);
      handle.queue = queue;
      return {
        size: queue.size,
        entries: queue.entries.map((entry) => firstText(entry.values)),
        onServer: queue.entries.map((entry) => entry.runId != null),
      };
    },
  });
  return { probe, queue: () => handle.queue! };
}

async function queueThree(side: Side, options: Record<string, unknown> = {}, strategy: string | undefined = "enqueue") {
  const { probe, queue } = await mountWithQueue(side, options);
  void probe.stream.submit(say("Msg1")).catch(() => undefined);
  await probe.until((s) => s.isLoading && s.threadId != null, "the first run");
  for (const content of ["Msg2", "Msg3", "Msg4"]) {
    void probe.stream
      .submit(say(content), strategy == null ? {} : { multitaskStrategy: strategy as never })
      .catch(() => undefined);
  }
  await probe.until(() => queue().size === 3, "three queued");
  const listed = { entries: queue().entries.map((e) => firstText(e.values)), onServer: queue().entries.map((e) => e.runId != null) };
  return { probe, queue, listed };
}

it("rapid submits during a run are listed in the queue and run in order", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { probe, listed } = await queueThree(side);
    await runsOf(probe.stream.threadId!, ended(4));
    await probe.until((s) => !s.isLoading && s.messages.length === 8, "the queue to drain");
    return { summary: await summary(probe), listed };
  });

  expectSameSummary(v1.summary, v2.summary, { fields: ["callbacks"], because: ["serverQueue"] });
  const created = (s: Summary) => s.callbacks.filter(([name]) => name === "onCreated").length;
  expect(created(v1.summary), "1.x").toBe(4);
  expect(created(v2.summary), "2.0").toBe(4);
  expect(v1.listed.entries).toEqual(["Msg2", "Msg3", "Msg4"]);
  expect(v2.listed.entries).toEqual(["Msg2", "Msg3", "Msg4"]);
  expect(v1.listed.onServer, is("serverQueue")).toEqual([false, false, false]);
  expect(v2.listed.onServer, is("serverQueue")).toEqual([true, true, true]);
  expect(texts(v2.summary)).toEqual(["Msg1", "Done.", "Msg2", "Done.", "Msg3", "Done.", "Msg4", "Done."]);
});

it("queue.cancel() drops a queued submit and clear() drops them all", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const one = await queueThree(side);
    await one.queue().cancel(one.queue().entries[0].id);
    await one.probe.until(() => one.queue().size === 2, "one cancelled");
    const afterCancel = one.queue().entries.map((e) => firstText(e.values));
    await one.probe.until((s) => !s.isLoading && s.messages.length === 6, "the rest to run");
    const cancelled = await summary(one.probe);
    await one.probe.unmount();

    const all = await queueThree(side);
    await all.queue().clear();
    await all.probe.until(() => all.queue().size === 0, "the queue cleared");
    await all.probe.until((s) => !s.isLoading && s.messages.length === 2, "the first run");
    await runsOf(all.probe.stream.threadId!, (runs) =>
      runs.every((run) => run.status !== "pending" && run.status !== "running")
    );
    return { afterCancel, cancelled, cleared: await summary(all.probe) };
  });

  expect(v1.afterCancel, "1.x").toEqual(["Msg3", "Msg4"]);
  expect(v2.afterCancel, "2.0").toEqual(["Msg3", "Msg4"]);
  expectSameSummary(v1.cancelled, v2.cancelled);
  expectSameSummary(v1.cleared, v2.cleared);
  expect(texts(v2.cleared)).toEqual(["Msg1", "Done."]);
});

it("a thread switch empties the shown queue, and 2.0's queued runs still run on the old thread", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { probe, queue } = await queueThree(side);
    const oldThread = probe.stream.threadId!;
    const { thread_id: otherThread } = await client.threads.create();
    await probe.rerender({ threadId: otherThread });
    await probe.until((s) => s.threadId === otherThread && queue().size === 0, "the switch");
    const oldRuns = await runsOf(oldThread, (runs) =>
      runs.every((run) => run.status !== "pending" && run.status !== "running")
    );
    return { queued: queue().size, oldRuns: oldRuns.length };
  });

  expect(v1.queued).toBe(0);
  expect(v2.queued).toBe(0);
  expect(v1.oldRuns, is("serverQueue")).toBe(1);
  expect(v2.oldRuns, is("serverQueue")).toBe(4);
});

it("a submit during a run waits for it on 2.0, and on 1.x though it asks to interrupt it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { probe } = await mountWithQueue(side);
    void probe.stream.submit(say("wait 2000")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the first run");
    void probe.stream.submit(say("Msg2")).catch(() => undefined);
    const runs = await runsOf(probe.stream.threadId!, ended(2));
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the last run");
    return { summary: await summary(probe), runs: oldestFirst(runs) };
  });

  expect(v1.runs, v1Bug("interruptLetsRunFinish")).toEqual(["success", "success"]);
  expect(v2.runs, is("submitDuringRunWaits")).toEqual(["success", "success"]);
  expect(texts(v2.summary)).toEqual(["wait 2000", "Done.", "Msg2", "Done."]);
});

it('a submit during a run with multitaskStrategy "interrupt" interrupts it on 2.0, and on 1.x the new run waits', async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { probe } = await mountWithQueue(side);
    void probe.stream.submit(say("wait 2000")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the first run");
    void probe.stream.submit(say("Msg2"), { multitaskStrategy: "interrupt" }).catch(() => undefined);
    const runs = await runsOf(probe.stream.threadId!, ended(2));
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the last run");
    return oldestFirst(runs);
  });

  expect(v2).toEqual(["interrupted", "success"]);
  expect(v1, v1Bug("interruptLetsRunFinish")).toEqual(["success", "success"]);
});

it('queue: "local" on 2.0 queues in the page, as 1.x does by default', async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { probe, listed } = await queueThree(side, side.name === "2.0" ? { queue: "local" } : {});
    await probe.until((s) => !s.isLoading && s.messages.length === 8, "the queue to drain");
    return { summary: await summary(probe), listed };
  });

  expect(v2.listed).toEqual(v1.listed);
  expectSameSummary(v1.summary, v2.summary);
});
