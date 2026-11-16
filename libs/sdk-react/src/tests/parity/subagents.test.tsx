import { expect, it, vi } from "vitest";

import { FANOUT_WORKER_COUNT } from "../fixtures/parallel-constants.js";
import { is } from "./differences.js";
import {
  asyncTaskThread,
  client,
  expectSameSummary,
  interruptSaved,
  normalizeIds,
  onBothSides,
  jsGraphs,
  onJsServer,
  runsOf,
  summary,
  wire,
  type Panel,
  type PanelSnapshot,
  type Probe,
  type Side,
  type Summary,
} from "./harness.js";

const ask = { messages: [{ type: "human", content: "Research and analyze" }] };
const ended = (runs: { status: string }[]) =>
  runs.length > 0 && runs.every((run) => run.status !== "pending" && run.status !== "running");
const withoutOutput = (s: Summary) =>
  (s.final.subagents as Record<string, unknown>[]).map(({ output: _output, ...rest }) => rest);
const subagentsOf = (probe: Probe) =>
  [...probe.stream.subagents.values()].sort((a, b) => a.name.localeCompare(b.name));
type Subagent = ReturnType<typeof subagentsOf>[number];

async function runDeepAgent(side: Side) {
  const probe = await side.mount({ assistantId: "deep_agent" });
  await probe.stream.submit(ask);
  await runsOf(probe.stream.threadId!, ended);
  await probe.until((s) => !s.isLoading, "the run");
  return probe;
}

const byNamespace = (subagent: { namespace: readonly string[] }) => ({ namespace: [...subagent.namespace] });
const namespaceLookedUp = (probe: Probe) =>
  subagentsOf(probe).map((subagent) => ({
    lookedUp: subagent.namespace[0] !== `tools:${subagent.id}`,
    depth: subagent.depth,
  }));

/**
 * Waits for a panel to pass `check`. On CI's Python server 1.x's panels miss
 * their subagent at times, so 1.x gets a shorter wait and a scenario checks
 * 2.0 alone when it misses. 2.0 must always pass.
 */
async function panelShows(side: Side, panel: Panel, check: (p: PanelSnapshot) => boolean, what: string) {
  return panel.until(check, what, side.name === "1.x" ? 10_000 : undefined).then(
    () => true,
    (error: unknown) => {
      if (side.name === "2.0") throw error;
      return false;
    }
  );
}

async function panelsFor(side: Side, probe: Probe, target: (subagent: Subagent) => unknown = (s) => s) {
  const panels = [];
  for (const subagent of subagentsOf(probe)) {
    const panel = await side.mountPanel(probe.stream, target(subagent));
    const filled = await panelShows(
      side,
      panel,
      (p) => p.messages.length > 0 && p.values.length > 0,
      `${subagent.name}'s messages and values`
    );
    panels.push({
      name: subagent.name,
      ...panel.latest,
      messages: panel.latest.messages.map(({ shape: _shape, ...message }) => message),
    });
    await panel.unmount();
    if (!filled) return null;
  }
  return normalizeIds(panels);
}

it("both sides find the same subagents, with the same fields", async () => {
  const { v1, v2 } = await onBothSides(async (side) => summary(await runDeepAgent(side)));

  expectSameSummary(v1, v2, {
    fields: ["final.subagents", ...(onJsServer ? [] : ["final.toolCalls"])],
    because: ["subagentOutputIsText", "rootToolCallsListSubagents", "commandOutputShownRaw"],
  });
  expect((v2.final.toolCalls as { name: string; output: unknown }[]).map((call) => [call.name, call.output])).toEqual([
    ["task", "Research completed: reconnect and lifecycle handling need coverage."],
    ["task", "Analysis completed: found 2 sample records."],
  ]);
  expect(normalizeIds(withoutOutput(v2))).toEqual(normalizeIds(withoutOutput(v1)));
  expect(withoutOutput(v2).map((s) => [s.name, s.status]).sort()).toEqual([
    ["data-analyst", "complete"],
    ["researcher", "complete"],
  ]);
});

it("a panel on each subagent, by the subagent or its namespace, shows the same messages and tool calls, and after a reload too", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await runDeepAgent(side);
    const live = await panelsFor(side, probe);
    const liveByNamespace = await panelsFor(side, probe, byNamespace);
    const threadId = probe.stream.threadId!;
    await probe.unmount();
    const reloaded = await side.mount({ assistantId: "deep_agent", threadId });
    await reloaded.until((s) => s.subagents.size === 2 && !s.isThreadLoading, "the subagents");
    const lookedUpOnLoad = namespaceLookedUp(reloaded);
    const reloadedPanels = await panelsFor(side, reloaded);
    return {
      live,
      liveByNamespace,
      lookedUpOnLoad,
      lookedUpOnUse: namespaceLookedUp(reloaded),
      reloaded: reloadedPanels,
      reloadedByNamespace: await panelsFor(side, reloaded, byNamespace),
    };
  });

  if ([v1.live, v1.liveByNamespace, v1.reloaded, v1.reloadedByNamespace].every((panels) => panels != null)) {
    if (onJsServer) expect(v2.live).toEqual(v1.live);
    expect(v2.reloaded).toEqual(v1.reloaded);
  }
  expect(v2.liveByNamespace).toEqual(v2.live);
  expect(v2.reloadedByNamespace).toEqual(v2.reloaded);
  expect(v2.lookedUpOnUse).toEqual(Array(2).fill({ lookedUp: true, depth: 1 }));
  expect(v2.lookedUpOnLoad, is("subagentNamespaceFoundOnUse")).toEqual(Array(2).fill({ lookedUp: !onJsServer, depth: 1 }));
  expect(v2.live!.map((p) => [p.name, p.toolCalls])).toEqual([
    ["data-analyst", [{ name: "query_database", status: "finished" }]],
    ["researcher", [{ name: "search_web", status: "finished" }]],
  ]);
});

it("a panel opened mid-run shows the subagent's earlier messages, a second panel on it opens nothing more, and closing them closes what they opened", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "deep_agent" });
    void probe.stream.submit(ask).catch(() => undefined);
    await probe.until(
      (s) => [...s.subagents.values()].some((sub) => sub.name === "researcher" && sub.status === "running"),
      "the researcher"
    );
    const openBefore = side.open.size;
    const researcher = subagentsOf(probe).find((s) => s.name === "researcher")!;
    const panel = await side.mountPanel(probe.stream, researcher);
    if (!(await panelShows(side, panel, (p) => p.messages.length > 0, "the researcher's messages"))) {
      await panel.unmount();
      await runsOf(probe.stream.threadId!, ended);
      return null;
    }
    const firstShown = panel.latest.messages.map((m) => m.type);
    const openWithPanel = side.open.size;
    const second = await side.mountPanel(probe.stream, researcher);
    await second.until((p) => p.messages.length > 0, "the second panel's messages");
    const openWithTwo = side.open.size;
    await second.unmount();
    await panel.unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const openAfter = side.open.size;
    await runsOf(probe.stream.threadId!, ended);
    return {
      firstShown,
      opened: openWithPanel - openBefore,
      openedBySecond: openWithTwo - openWithPanel,
      closed: openWithPanel - openAfter,
    };
  });

  if (v1?.firstShown[0] === "human") expect(v2!.firstShown.slice(0, v1.firstShown.length)).toEqual(v1.firstShown);
  expect(v2!.firstShown[0]).toBe("human");
  expect(v2!.opened).toBe(1);
  expect(v2!.openedBySecond).toBe(0);
  expect(v2!.closed).toBe(v2!.opened);
});

it("many parallel subagents after a reload: a bounded number of history reads, and the root keeps its last message", async () => {
  const { v2 } = await onBothSides(async (side) => {
    const historyReadsSince = (from: number) =>
      wire(side.requests.slice(from)).filter((r) => r.endsWith("/history")).length;
    const probe = await side.mount({ assistantId: "parallel_fanout" });
    await probe.stream.submit({ messages: [{ type: "human", content: "Fan out" }] });
    await runsOf(probe.stream.threadId!, ended);
    const threadId = probe.stream.threadId!;
    await probe.unmount();

    const atReload = side.requests.length;
    const reloaded = await side.mount({ assistantId: "parallel_fanout", threadId });
    await reloaded.until((s) => s.subagents.size === FANOUT_WORKER_COUNT && !s.isThreadLoading, "the subagents");
    const onReload = historyReadsSince(atReload);
    const atPanels = side.requests.length;
    const panels = [];
    for (const subagent of subagentsOf(reloaded)) {
      panels.push(await side.mountPanel(reloaded.stream, subagent));
    }
    await Promise.all(panels.map((panel) => panelShows(side, panel, (p) => p.messages.length > 0, "a worker's messages")));
    await summary(reloaded);
    return {
      onReload,
      withPanels: historyReadsSince(atPanels),
      statuses: subagentsOf(reloaded).map((s) => s.status),
      lastMessage: reloaded.stream.messages.at(-1)?.text,
    };
  });

  expect(v2.onReload).toBeLessThanOrEqual(3);
  expect(v2.withPanels).toBeLessThanOrEqual(FANOUT_WORKER_COUNT + 2);
  expect(v2.statuses).toEqual(Array(FANOUT_WORKER_COUNT).fill("complete"));
  expect(v2.lastMessage).toBe("All workers completed.");
});

it("useValues gives the same values, at the root and on a subagent", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({
      assistantId: "stateful_values_graph",
      extra: (stream, hooks) => ({
        sameAsStream: hooks.useValues(stream) === stream.values,
        keys: Object.keys((hooks.useValues(stream) as object) ?? {}).sort(),
      }),
    });
    await probe.stream.submit({ messages: [{ type: "human", content: "Hello" }] });
    await runsOf(probe.stream.threadId!, ended);
    const root = await summary(probe);
    const deep = await runDeepAgent(side);
    const panel = await side.mountPanel(deep.stream, subagentsOf(deep)[0]);
    const shown = await panelShows(side, panel, (p) => p.values.length > 0, "the subagent's values");
    return { root, subagentValues: shown ? panel.latest.values : null };
  });

  expectSameSummary(v1.root, v2.root);
  expect(v2.root.final.extra).toEqual(expect.objectContaining({ sameAsStream: true }));
  if (v1.subagentValues != null) expect(v2.subagentValues).toEqual(v1.subagentValues);
  expect(v2.subagentValues?.length).toBeGreaterThan(0);
});

/**
 * A panel opened on the first subgraph once the run ended, which for
 * `parallel_subgraph` is whichever worker started first.
 */
const PANEL_AFTER_RUN: Record<string, unknown[]> = {
  subgraph_graph: ["Hello", "Reply from child"],
  embedded_subgraph_graph: ["Hello", "Subgraph reply"],
  parallel_subgraph: [expect.stringMatching(/^Subtask \d$/), "Subgraph reply"],
};

for (const graph of Object.keys(PANEL_AFTER_RUN)) {
  it(`subgraphs and subgraphsByNode list the same subgraphs for ${graph}, a panel opened after the run, and a reload reads a bounded history`, async () => {
    const { v1, v2 } = await onBothSides(async (side) => {
      const extra = (stream: Probe["stream"]) => ({
        subgraphs: [...stream.subgraphs.values()]
          .map((s) => `${s.nodeName}:${s.status}:${s.namespace.length}`)
          .sort(),
        byNode: [...stream.subgraphsByNode.entries()].map(([node, list]) => `${node}:${list.length}`).sort(),
        subagents: stream.subagents.size,
      });
      const probe = await side.mount({ assistantId: graph, extra });
      await probe.stream.submit({ messages: [{ type: "human", content: "Hello" }] });
      await runsOf(probe.stream.threadId!, ended);
      await probe.until((s) => !s.isLoading, "the run");
      const panel = await side.mountPanel(probe.stream, [...probe.stream.subgraphs.values()][0]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const panelTexts = panel.latest.messages.map((m) => m.text);
      await panel.unmount();
      const live = (await summary(probe)).final.extra;
      const atReload = side.requests.length;
      const reloaded = await side.mount({ assistantId: graph, threadId: probe.stream.threadId, extra });
      await reloaded.until((s) => !s.isThreadLoading && s.messages.length > 0, "the reload");
      return {
        live,
        panelTexts,
        reloaded: (await summary(reloaded)).final.extra,
        historyReads: wire(side.requests.slice(atReload)).filter((r) => r.endsWith("/history")).length,
      };
    });

    expect(v2.live).toEqual(v1.live);
    expect(v2.panelTexts).toEqual(PANEL_AFTER_RUN[graph]);
    expect(v1.panelTexts, is("streamedContentIsString")).toEqual([
      ...PANEL_AFTER_RUN[graph],
      ...(graph === "embedded_subgraph_graph" && jsGraphs ? ["Research done"] : []),
    ]);
    expect((v2.live as { subgraphs: string[] }).subgraphs.length).toBeGreaterThan(0);
    expect((v2.live as { subagents: number }).subagents).toBe(0);
    expect(v2.reloaded, is("subgraphsAfterReload")).toEqual({ subgraphs: [], byNode: [], subagents: 0 });
    for (const side of [v1, v2]) expect(side.historyReads).toBeLessThanOrEqual(3);
  });
}

it.skipIf(jsGraphs)("an async subagent's panel on its own thread shows its run live, and its next run", async () => {
  const say = (content: string) => ({ messages: [{ type: "human", content }] });
  const { v1, v2 } = await onBothSides(async (side) => {
    const lead = await side.mount({ assistantId: "async_subagent" });
    void lead.stream.submit(say("Research the protocol's history")).catch(() => undefined);
    await lead.until((s) => asyncTaskThread(s.values) != null, "the task");
    const threadId = asyncTaskThread(lead.stream.values)!;
    const panel = await side.mount({ assistantId: "async_researcher", threadId });
    await runsOf(threadId, (runs) => ended(runs) && runs.length === 1);
    await lead.until((s) => !s.isLoading, "the lead's run");
    await lead.stream.submit(say("Add the dates too"));
    await runsOf(threadId, (runs) => ended(runs) && runs.length === 2);
    return summary(panel);
  });

  if (v1.loading.includes(true)) {
    expectSameSummary(v1, v2, { fields: ["callbacks"], because: ["joinedRunCompletedWithId"] });
  }
  expect(v2.final.messages.map((m) => m.text)).toEqual([
    "Research the protocol's history",
    "Research finished.",
    "Add the dates too",
    "Research finished.",
  ]);
  expect(v2.loading).toEqual([false, true, false, true, false]);
  expect(v2.streamedInParts).toBe(true);
});

it.skipIf(jsGraphs)("with five subagent panels and an async subagent's panel open, respond() and stop() still go through", async () => {
  const parts = [1, 2, 3, 4, 5].map((i) => `Check part ${i}`);
  const { v1, v2 } = await onBothSides(async (side) => {
    const lead = await side.mount({ assistantId: "five_workers" });
    void lead.stream.submit({ messages: [{ type: "human", content: "Check the plan" }] }).catch(() => undefined);
    await lead.until(
      (s) => [...s.subagents.values()].filter((sub) => sub.status === "running").length === parts.length,
      "the running workers"
    );
    const threadId = lead.stream.threadId!;
    const reviewThreadId = await vi.waitFor(
      async () => {
        const [thread] = await client.threads.search({ metadata: { parent_thread_id: threadId } });
        if (thread == null) throw new Error(`no review thread for ${threadId}`);
        return thread.thread_id;
      },
      { timeout: 30_000, interval: 100 }
    );
    await interruptSaved(reviewThreadId);
    const review = await side.mount({ assistantId: "async_reviewer", threadId: reviewThreadId });
    await review.until((s) => s.interrupt != null, "the review's approval");

    const workers = subagentsOf(lead);
    const panels: Panel[] = [];
    for (const worker of workers) panels.push(await side.mountPanel(lead.stream, worker));
    const shown = await Promise.all(
      panels.map((panel, i) =>
        panelShows(side, panel, (p) => p.messages.some((m) => m.type === "ai" && m.text.length > 0), `${workers[i].taskInput}'s reply`)
      )
    );
    if (side.name === "2.0") {
      await expect
        .poll(() => [...side.open].filter((stream) => stream.includes(threadId)).length, {
          message: "the run's own stream and one join for all five panels",
        })
        .toBe(2);
    }

    await review.stream.respond({ approved: true });
    const [runWhenAnswered] = await client.runs.list(threadId);
    await lead.stream.stop();
    const runs = await runsOf(threadId, ended);
    await runsOf(reviewThreadId, (all) => all.length === 2 && ended(all));
    await review.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Review finished.", "the review's reply");
    return {
      panels: shown.every(Boolean)
        ? panels.map((panel) => panel.latest.messages.find((m) => m.type === "human")?.text).sort()
        : null,
      runWhenAnswered: runWhenAnswered.status,
      runs: runs.map((run) => run.status),
      lead: await summary(lead),
      review: await summary(review),
    };
  });

  expect(v2.panels).toEqual(parts);
  if (v1.panels != null) expect(v1.panels).toEqual(v2.panels);
  for (const side of [v1, v2]) {
    expect(side.runWhenAnswered).toBe("running");
    expect(side.runs).toEqual(["interrupted"]);
  }
  expect(v2.lead.callbacks.at(-1)).toEqual(["onCompleted", expect.objectContaining({ reason: "stopped" })]);
  expectSameSummary(v1.review, v2.review, {
    fields: ["callbacks", "loading"],
    because: ["pausedThreadBlinksLoading", "answerRunsUntracked"],
  });
  expect(v2.review.final.messages.map((m) => m.text)).toEqual(["Review the plan", "Review finished."]);
  expect(v2.review.loading).toEqual([false, true, false]);
});
