import { Client } from "@langchain/langgraph-sdk";
import { expect, it } from "vitest";

import { is, v1Bug } from "./differences.js";
import {
  apiUrl,
  asyncTaskThread,
  client,
  droppableFetch,
  expectSameSummary,
  hydrateOn,
  normalizeIds,
  onBothSides,
  jsGraphs,
  onJsServer,
  runsOf,
  summary,
  type Hooks,
  type Probe,
  type Side,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count && runs.every((run) => run.status !== "pending" && run.status !== "running");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 1.x's subagent panel on an Agent Server can end with an empty tool message. */
const withoutEmptyTool = <P extends { messages: { type: string; text: string }[] }>(panel: P): P => ({
  ...panel,
  messages: panel.messages.filter((m) => m.type !== "tool" || m.text !== ""),
});

async function panelOf(side: Side, probe: Probe, target: unknown) {
  const panel = await side.mountPanel(probe.stream, target);
  await panel.until((p) => p.messages.length > 0 && p.toolCalls.length > 0, "the panel");
  const shown = normalizeIds({ ...panel.latest, messages: panel.latest.messages.map(({ shape: _shape, ...m }) => m) });
  await panel.unmount();
  return shown;
}

async function asyncSubagentPanel(side: Side) {
  const lead = await side.mount({ assistantId: "async_subagent" });
  void lead.stream.submit(say("Research the protocol's history")).catch(() => undefined);
  await lead.until((s) => asyncTaskThread(s.values) != null, "the task");
  const leadThreadId = lead.stream.threadId!;
  const threadId = asyncTaskThread(lead.stream.values)!;
  // A third thread on the page would take every connection on 1.x (`twoStreamsPerThread`).
  await lead.unmount();
  const panel = await side.mount({ assistantId: "async_researcher", threadId });
  await runsOf(threadId, ended(1));
  await runsOf(leadThreadId, ended(1));
  const shown = await summary(panel);
  await panel.unmount();
  return shown;
}

it("a deep agent app: a message on a thread made beforehand, a subagent's approval, its panel, the queue, disconnect and a reload", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { thread_id: premade } = await client.threads.create();
    const toolEvents: string[] = [];
    let messageEvents = 0;
    const appOptions = {
      client: new Client({ apiUrl }),
      defaultHeaders: { "x-auth-scheme": "langsmith-agent" },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
      messagesKey: "messages",
    };
    const selectors = (stream: Probe["stream"], hooks: Hooks) => {
      const queue = hooks.useSubmissionQueue(stream);
      hooks.useChannelEffect(stream, ["tools"], {
        enabled: true,
        replay: false,
        onEvent: (event) => toolEvents.push(`${event.params.data.event}:${event.params.data.tool_name ?? ""}`),
      });
      hooks.useChannelEffect(stream, ["messages"], { replay: false, onEvent: () => (messageEvents += 1) });
      return { queued: queue.size };
    };
    const probe = await side.mount({ assistantId: "deep_agent_interrupt", threadId: null, options: appOptions, extra: selectors });
    await probe.stream.submit(say("Change it"), {
      threadId: premade,
      config: { configurable: { model: "app" } },
      metadata: { source: "app" },
      multitaskStrategy: "enqueue",
    });
    await probe.until((s) => s.interrupt != null, "the subagent's approval");
    const [waiting] = probe.stream.getThread()!.interrupts;
    await probe.stream.respond({ approved: true }, {
      interruptId: waiting.interruptId,
      namespace: waiting.namespace,
      config: { configurable: { model: "app" } },
      metadata: { answeredBy: "app" },
    } as never);
    const runs = await runsOf(premade, ended(2));
    await probe.until((s) => !s.isLoading && s.subagents.size === 1, "the agent's answer");
    const panel = await panelOf(side, probe, [...probe.stream.subagents.values()][0]);
    const live = await summary(probe);
    probe.stream.disconnect();
    await probe.unmount();

    const reloaded = await side.mount({ assistantId: "deep_agent_interrupt", threadId: premade, options: appOptions, extra: selectors });
    await reloaded.until((s) => !s.isThreadLoading && s.messages.length === live.final.messages.length, "the thread");
    const sorted = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      live,
      reloaded: await summary(reloaded),
      panel,
      sawMessages: messageEvents > 0,
      toolEvents: [...new Set(toolEvents)].sort(),
      onServer: sorted.map((run) => ({
        model: (run.kwargs as { config?: { configurable?: { model?: string } } }).config?.configurable?.model,
        metadata: (run.metadata as Record<string, unknown>).source ?? (run.metadata as Record<string, unknown>).answeredBy,
      })),
    };
  });

  for (const key of ["live", "reloaded"] as const) {
    expectSameSummary(v1[key], v2[key], {
      fields: ["callbacks", "loading", "final.subagents", ...(onJsServer ? [] : ["final.toolCalls"])],
      because: [
        "answerRunsUntracked",
        "subagentOutputIsText",
        "subagentNamespaceFoundOnUse",
        "rootToolCallsListSubagents",
        "commandOutputShownRaw",
      ],
    });
  }
  expect(v2.live.final.messages.at(-1)?.text).toBe("Subagent approval completed.");
  expect(v2.panel, v1Bug("commandOutputShownRaw")).toEqual(withoutEmptyTool(v1.panel));
  expect(v2.onServer).toEqual([{ model: "app", metadata: "app" }, { model: "app", metadata: "app" }]);
  expect(v1.onServer).toEqual(v2.onServer);
  expect(v1.sawMessages && v2.sawMessages).toBe(true);
  expect(v2.toolEvents).toEqual(["tool-finished:", "tool-started:task"]);
  expect(v1.toolEvents, is("rootChannelsIncludeSubagents")).toEqual(
    jsGraphs ? v2.toolEvents : ["tool-finished:", "tool-started:request_approval", "tool-started:task"]
  );
});

it("an app on the server queue: the reconnect options through a dropped connection, its channels, and panels by namespace", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const network = droppableFetch();
    let reconnects = 0;
    const custom: unknown[] = [];
    const runEnds: string[] = [];
    const queueOptions = {
      client: new Client({ apiUrl }),
      fetch: network.fetch,
      queue: "server",
      maxReconnectAttempts: 5,
      reconnectDelayMs: () => 0,
      onReconnect: () => (reconnects += 1),
      onConnected: () => undefined,
    };
    const selectors = (stream: Probe["stream"], hooks: Hooks) => {
      hooks.useChannelEffect(stream, ["custom"], { onEvent: (event) => custom.push(event.params.data) });
      hooks.useChannelEffect(stream, ["lifecycle", "messages"], {
        onEvent: (event) => {
          if (event.method === "lifecycle" && event.params.namespace.length === 0) runEnds.push(event.params.data.event);
        },
      });
      return { queued: hooks.useSubmissionQueue(stream).entries.length };
    };
    const probe = await side.mount({ assistantId: "deep_agent", options: queueOptions, extra: selectors });
    const threadErrors: unknown[] = [];
    void probe.stream.submit(say("Research and analyze")).catch(() => undefined);
    await probe.until((s) => s.threadId != null && s.isLoading, "the run");
    probe.stream.getThread()?.onError((error: unknown) => threadErrors.push(error));
    await sleep(300);
    network.drop();
    await runsOf(probe.stream.threadId!, ended(1));
    await probe.until((s) => !s.isLoading && [...s.subagents.values()].every((sub) => sub.status === "complete"), "the run's end");
    const panels = [];
    for (const subagent of [...probe.stream.subagents.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      panels.push(await panelOf(side, probe, { namespace: [...subagent.namespace] }));
    }
    const run = await summary(probe);
    await probe.unmount();

    const status = await side.mount({ assistantId: "custom_channel_graph", options: queueOptions, extra: selectors });
    await status.stream.submit(say("Status"));
    await runsOf(status.stream.threadId!, ended(1));
    await summary(status);
    return { run, panels, reconnected: reconnects > 0, threadErrors: threadErrors.length, runEnds, custom: custom.length };
  });

  expectSameSummary(v1.run, v2.run, {
    fields: ["final.subagents", ...(onJsServer ? [] : ["final.toolCalls"])],
    because: ["subagentOutputIsText", "rootToolCallsListSubagents", "commandOutputShownRaw"],
  });
  if (onJsServer) expect(v2.panels).toEqual(v1.panels);
  expect(v1.reconnected, is("fetch")).toBe(true);
  expect(v2.reconnected, is("fetch")).toBe(false);
  expect(v2.custom).toBe(3);
  expect(v1.custom).toBe(3);
  for (const [name, side] of [["1.x", v1], ["2.0", v2]] as const) {
    expect({ threadErrors: side.threadErrors, ended: side.runEnds.at(-1) }, name).toEqual({
      threadErrors: 0,
      ended: "completed",
    });
  }
});

it("an app with useValues, an approval, a subagent panel, an async subagent's panel, and hydrate() when a tab shows again after another tab's run", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({
      assistantId: "deep_agent_interrupt",
      extra: (stream, hooks) => ({ valuesKeys: Object.keys(hooks.useValues(stream) ?? {}).sort() }),
    });
    await probe.stream.submit(say("Change it"));
    await probe.until((s) => s.interrupt != null, "the subagent's approval");
    await probe.stream.respondAll({ [probe.stream.interrupt!.id!]: { approved: true } });
    const threadId = probe.stream.threadId!;
    await runsOf(threadId, ended(2));
    await probe.until((s) => !s.isLoading && s.subagents.size === 1, "the agent's answer");
    const panel = await panelOf(side, probe, [...probe.stream.subagents.values()][0]);
    const asyncPanel = jsGraphs ? null : await asyncSubagentPanel(side);

    await client.runs.wait(threadId, "slow_graph", { input: say("From the other tab") });
    await hydrateOn(side, probe);
    await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Done.", "the other tab's messages");
    return { summary: await summary(probe), panel, asyncPanel };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: [
      "callbacks",
      "loading",
      "final.subagents",
      "final.valuesKeys",
      "final.extra",
      "threadLoading",
      ...(onJsServer ? [] : ["final.toolCalls"]),
    ],
    because: [
      "answerRunsUntracked",
      "subagentOutputIsText",
      "valuesOnlyFromGraph",
      "quietSameThreadHydrate",
      "rootToolCallsListSubagents",
    ],
  });
  expect(v2.panel, v1Bug("commandOutputShownRaw")).toEqual(withoutEmptyTool(v1.panel));
  expect(v2.summary.final.messages.slice(-2).map((m) => m.text)).toEqual(["From the other tab", "Done."]);
  if (v1.asyncPanel == null || v2.asyncPanel == null) return;
  expect(v2.asyncPanel.final.messages.map((m) => m.text)).toEqual(["Research the protocol's history", "Research finished."]);
  expect(v2.asyncPanel.loading).toEqual([false, true, false]);
  expect(v2.asyncPanel.streamedInParts).toBe(true);
  if (v1.asyncPanel.loading.includes(true)) {
    expectSameSummary(v1.asyncPanel, v2.asyncPanel, { fields: ["callbacks"], because: ["joinedRunCompletedWithId"] });
  }
});

it("assistant-ui's setup: the caller's options passed through, and useChannel on custom", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { thread_id: threadId } = await client.threads.create();
    const probe = await side.mount({
      assistantId: "custom_channel_graph",
      threadId,
      options: { apiKey: undefined, messagesKey: "messages", defaultHeaders: { "x-adapter": "assistant-ui" } },
      extra: (stream, hooks) => ({ custom: hooks.useChannel(stream, ["custom"]).length }),
    });
    await probe.stream.submit(say("Hello"));
    await runsOf(threadId, ended(1));
    await probe.until((s) => !s.isLoading, "the run");
    return summary(probe);
  });

  expectSameSummary(v1, v2);
  expect(v2.final.extra).toEqual({ custom: 3 });
  expect(v2.final.messages.map((m) => m.text)).toEqual(["Hello", "Custom channel reply"]);
});
