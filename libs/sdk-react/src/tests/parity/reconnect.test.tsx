import { expect, it } from "vitest";

import { droppableFetch, expectSameSummary, hydrateOn, onBothSides, runsOf, summary } from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count && runs.every((run) => run.status !== "pending" && run.status !== "running");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a run's stream dropped mid-run through a custom fetch reconnects, and the answer arrives", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const network = droppableFetch();
    let reconnects = 0;
    const probe = await side.mount({
      assistantId: "slow_graph",
      options: {
        fetch: network.fetch,
        maxReconnectAttempts: 5,
        reconnectDelayMs: () => 0,
        onReconnect: () => (reconnects += 1),
      },
    });
    void probe.stream.submit(say("wait 2000")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the run");
    await sleep(300);
    const openedBefore = network.opened();
    network.drop();
    const [run] = await runsOf(probe.stream.threadId!, ended(1));
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the answer");
    return {
      summary: await summary(probe),
      reopened: network.opened() > openedBefore,
      reconnects,
      run: run.status,
    };
  });

  expectSameSummary(v1.summary, v2.summary);
  for (const side of [v1, v2]) {
    expect(side.reopened).toBe(true);
    expect(side.reconnects).toBeGreaterThan(0);
    expect(side.run).toBe("success");
  }
});

it("an approval answered after the stream dropped still resumes the run", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const network = droppableFetch();
    const probe = await side.mount({
      assistantId: "interrupt_graph",
      options: { fetch: network.fetch, maxReconnectAttempts: 5, reconnectDelayMs: () => 0 },
    });
    await probe.stream.submit({ request: "send the report" });
    await probe.until((s) => s.interrupt != null && !s.isLoading, "the approval");
    network.drop();
    await sleep(300);
    await probe.stream.respond({ approved: true });
    await runsOf(probe.stream.threadId!, ended(2));
    await probe.until((s) => !s.isLoading && s.interrupt == null, "the answer's run");
    return summary(probe);
  });

  expectSameSummary(v1, v2, {
    fields: ["final.valuesKeys", "callbacks", "loading"],
    because: ["valuesOnlyFromGraph", "answerRunsUntracked"],
  });
  expect(v2.final.interrupts).toEqual([]);
});

it("hydrate() after the stream dropped with reconnects off shows the run's answer", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const network = droppableFetch();
    const probe = await side.mount({
      assistantId: "slow_graph",
      options: { fetch: network.fetch, maxReconnectAttempts: 0 },
    });
    void probe.stream.submit(say("wait 1500")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the run");
    await sleep(300);
    network.drop();
    await sleep(300);
    await hydrateOn(side, probe);
    await runsOf(probe.stream.threadId!, ended(1));
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the answer");
    return probe.stream.messages.map((m) => m.text);
  });

  expect(v1).toEqual(["wait 1500", "Done."]);
  expect(v2).toEqual(["wait 1500", "Done."]);
});

it("hydrate() called again and again while a run ends leaves its messages once each", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "slow_graph" });
    void probe.stream.submit(say("wait 1000")).catch(() => undefined);
    await probe.until(() => probe.calls.some(([name]) => name === "onCreated"), "the run");
    const threadId = probe.stream.threadId!;
    let running = true;
    const hydrating = (async () => {
      while (running) {
        await hydrateOn(side, probe).catch(() => undefined);
        await sleep(100);
      }
    })();
    await runsOf(threadId, ended(1));
    await sleep(300);
    running = false;
    await hydrating;
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the answer");
    return summary(probe);
  });

  expect(v2.final.messages.map((m) => m.text)).toEqual(["wait 1000", "Done."]);
  expect(v1.final.messages).toEqual(v2.final.messages);
});
