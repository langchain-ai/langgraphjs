import { expect, it } from "vitest";

import {
  backend,
  client,
  expectSameSummary,
  onBothSides,
  onJsServer,
  onSide,
  runsOf,
  summary,
  type Hooks,
  type Probe,
  type Summary,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count && runs.every((run) => run.status !== "pending" && run.status !== "running");
const texts = (s: Summary) => s.final.messages.map((m) => m.text);

/** Threads 1.x used, each with the graph it ran. */
const GRAPHS = { finished: "stategraph_text", paused: "interrupt_graph", subagents: "deep_agent" } as const;

it("threads 1.x used open the same on both sides, and 2.0 answers the approval and sends the next message", async () => {
  const threads = await onSide("1.x", async (side) => {
    const used = async (name: keyof typeof GRAPHS, input: unknown, done: (s: Probe["stream"]) => boolean) => {
      const probe = await side.mount({ assistantId: GRAPHS[name] });
      await probe.stream.submit(input as never);
      await runsOf(probe.stream.threadId!, ended(1));
      await probe.until(done, `the ${name} thread`);
      await probe.unmount();
      return probe.stream.threadId!;
    };
    return {
      finished: await used("finished", say("Hello"), (s) => !s.isLoading && s.messages.length === 2),
      paused: await used("paused", { request: "send the report" }, (s) => !s.isLoading && s.interrupt != null),
      subagents: await used("subagents", say("Research and analyze"), (s) => !s.isLoading && s.subagents.size === 2),
    };
  });

  const { v1, v2 } = await onBothSides(async (side) => {
    const opened: Partial<Record<keyof typeof GRAPHS, Summary>> = {};
    for (const name of Object.keys(GRAPHS) as (keyof typeof GRAPHS)[]) {
      const probe = await side.mount({
        assistantId: GRAPHS[name],
        threadId: threads[name],
        extra: (stream) => ({ subagents: [...stream.subagents.values()].map((s) => `${s.name}:${s.status}`).sort() }),
      });
      await probe.until(
        (s) => !s.isThreadLoading && (s.messages.length > 0 || s.interrupt != null),
        `the ${name} thread`
      );
      opened[name] = await summary(probe);
      await probe.unmount();
    }
    return opened as Record<keyof typeof GRAPHS, Summary>;
  });

  expectSameSummary(v1.finished, v2.finished);
  expectSameSummary(v1.subagents, v2.subagents, {
    fields: ["final.subagents"],
    because: ["subagentOutputIsText", "subagentNamespaceFoundOnUse"],
  });
  expectSameSummary(v1.paused, v2.paused, {
    fields: ["final.valuesKeys", "loading", "callbacks"],
    because: ["valuesOnlyFromGraph", "pausedThreadBlinksLoading"],
  });
  expect(v2.paused.loading).toEqual([false]);
  expect(v2.paused.callbacks).toEqual([]);
  expect(v2.paused.final.interrupt).not.toBeNull();
  expect(v2.subagents.final.extra).toEqual({ subagents: ["data-analyst:complete", "researcher:complete"] });

  const carriedOn = await onSide("2.0", async (side) => {
    const paused = await side.mount({ assistantId: GRAPHS.paused, threadId: threads.paused });
    await paused.until((s) => s.interrupt != null, "the approval");
    await paused.stream.respond({ approved: true });
    await runsOf(threads.paused, ended(2));
    await paused.until((s) => !s.isLoading && s.interrupt == null, "the answer's run");
    const finished = await side.mount({ assistantId: GRAPHS.finished, threadId: threads.finished });
    await finished.until((s) => s.messages.length === 2, "the thread");
    await finished.stream.submit(say("Again"));
    await finished.until((s) => !s.isLoading && s.messages.length === 4, "the next run");
    return { answered: (paused.stream.values as { completed?: boolean }).completed, finished: await summary(finished) };
  });

  expect(carriedOn.answered).toBe(true);
  expect(texts(carriedOn.finished)).toEqual(["Hello", "Plan accepted.", "Again", "Plan accepted."]);
});

it("a page that moves to 2.0 while 1.x's run streams and its next one waits on the server shows both run", async () => {
  const threadId = await onSide("1.x", async (side) => {
    const probe = await side.mount({ assistantId: "slow_graph", options: { queue: "server" } });
    void probe.stream.submit(say("wait 2500")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the first run");
    // An Agent Server starts 1.x's default submit only once the run ends (`interruptLetsRunFinish`).
    void probe.stream.submit(say("Msg2"), onJsServer ? {} : { multitaskStrategy: "enqueue" }).catch(() => undefined);
    await runsOf(probe.stream.threadId!, (runs) => runs.length === 2 && runs.some((run) => run.status === "pending"));
    return probe.stream.threadId!;
  });

  const upgraded = await onSide("2.0", async (side) => {
    let queued: ReturnType<Hooks["useSubmissionQueue"]> | undefined;
    const probe: Probe = await side.mount({
      assistantId: "slow_graph",
      threadId,
      extra: (stream, hooks) => {
        queued = hooks.useSubmissionQueue(stream);
        return null;
      },
    });
    await probe.until((s) => s.isLoading && queued?.size === 1, "the running run and the queued one");
    await runsOf(threadId, ended(2));
    await probe.until((s) => !s.isLoading, "both runs");
    const done = await summary(probe);
    const counts = probe.trace.map((s) => s.messages.length);
    return { summary: done, rewound: counts.some((count, i) => count < counts[i - 1]) };
  });

  expect(texts(upgraded.summary), "the last values of each run 1.x started show").toEqual([
    "wait 2500",
    "Done.",
    "Msg2",
    "Done.",
  ]);
  expect(upgraded.rewound, "no message disappears while 2.0 follows 1.x's run").toBe(false);
});

// The dev servers store a run's config on its thread differently, so this checks the Agent Server on Postgres alone.
it.skipIf(backend !== "url")("a thread 1.x used keeps no stream marker, and 2.0's runs there send it off and drop no message", async () => {
  const threadId = await onSide("1.x", async (side) => {
    const probe = await side.mount({ assistantId: "stategraph_text" });
    await probe.stream.submit(say("Hello"));
    await runsOf(probe.stream.threadId!, ended(1));
    await probe.until((s) => !s.isLoading && s.messages.length === 2, "the run");
    return probe.stream.threadId!;
  });

  const counts = await onSide("2.0", async (side) => {
    const probe = await side.mount({ assistantId: "stategraph_text", threadId });
    await probe.until((s) => s.messages.length === 2, "the thread");
    await probe.stream.submit(say("Again"));
    await runsOf(threadId, ended(2));
    await probe.until((s) => !s.isLoading && s.messages.length === 4, "2.0's run");
    return probe.trace.map((s) => s.messages.length);
  });

  const marker = (config: unknown) =>
    (config as { configurable?: Record<string, unknown> } | undefined)?.configurable?.__event_streaming_v2;
  const runs = (await client.runs.list(threadId)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  expect(runs.map((run) => marker(run.kwargs?.config)), "1.x's run, then 2.0's").toEqual([true, false]);
  expect(marker((await client.threads.get(threadId)).config), "the thread's config").toBeUndefined();
  expect(counts.some((count, i) => count < counts[i - 1]), "a message disappeared while 2.0's run streamed").toBe(false);
});
