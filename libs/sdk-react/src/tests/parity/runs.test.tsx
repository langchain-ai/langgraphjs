import { expect, it } from "vitest";

import { is, v1Bug } from "./differences.js";
import {
  client,
  contentShapes,
  expectSameSummary,
  itOnAgentServer,
  messagesOnly,
  onBothSides,
  onJsServer,
  onSide,
  runsOf,
  summary,
  wire,
  type Summary,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const texts = (s: Summary) => s.final.messages.map((m) => m.text);

it("a reply streams in parts, and both sides end with the same messages and values", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({
      assistantId: "stategraph_text",
      extra: (stream, hooks) => ({
        useMessagesIsStreamMessages:
          hooks.useMessages(stream).map((m) => m.id).join() ===
          stream.messages.map((m) => m.id).join(),
        useToolCallsIsStreamToolCalls:
          hooks.useToolCalls(stream).length === stream.toolCalls.length,
      }),
    });
    await probe.stream.submit(say("Hello"));
    const threadId = probe.stream.threadId!;
    const [run] = await client.runs.list(threadId);
    return {
      summary: await summary(probe),
      shapes: contentShapes(probe),
      runWhenSubmitResolved: run.status,
      wire: wire(side.requests),
    };
  });

  expectSameSummary(v1.summary, v2.summary);
  expect(v1.shapes, is("streamedContentIsString")).toEqual(["string", "blocks"]);
  expect(v2.shapes, is("streamedContentIsString")).toEqual(["string", "string"]);
  expect(v2.summary.streamedInParts).toBe(true);
  expect(v2.summary.final.messages.map((m) => [m.type, m.text, m.isClass])).toEqual([
    ["human", "Hello", true],
    ["ai", "Plan accepted.", true],
  ]);
  for (const side of [v1, v2]) {
    expect(side.runWhenSubmitResolved).toBe("success");
    expect(side.summary.final.extra).toEqual({
      useMessagesIsStreamMessages: true,
      useToolCallsIsStreamToolCalls: true,
    });
  }
  expect(v1.wire[0], is("threadCreatedFirst")).toBe("POST /threads/:id/commands");
  expect(v2.wire, is("threadCreatedFirst")).toEqual([
    "GET /info",
    "POST /threads",
    "POST /threads/:id/runs/stream",
    ...(messagesOnly ? ["GET /threads/:id/state"] : []),
    "GET /threads/:id/stream",
  ]);
});

it("a message the graph removes disappears on both sides", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "remove_message_graph" });
    await probe.stream.submit(say("Hello"));
    return summary(probe);
  });

  expectSameSummary(v1, v2);
  expect(v2.final.messages.map((m) => m.text)).toEqual([
    "Hello",
    "Step 2: To Keep",
    "Step 3: To Keep",
  ]);
});

itOnAgentServer("with stateKeys: [], 2.0's runs, answers and queued runs ask for no values and end on the server's messages, and a values-only run another client starts shows live and final", async () => {
  const serverTexts = async (threadId: string) =>
    ((await client.threads.getState(threadId)).values as { messages: { content: unknown }[] }).messages.map((m) => m.content);

  const shown = await onSide("2.0", async (side) => {
    const texts = (probe: { stream: { messages: { text: string }[] } }) => probe.stream.messages.map((m) => m.text);
    const approving = await side.mount({ assistantId: "interrupt_card_graph", options: { stateKeys: [] } });
    await approving.stream.submit(say("Hello"));
    await approving.until((s) => !s.isLoading && s.interrupts.length === 1, "the approval");
    await approving.stream.respond({ approved: true });
    await approving.until((s) => !s.isLoading && s.interrupts.length === 0 && s.messages.length === 4, "the answered run");
    const threadId = approving.stream.threadId!;
    const answered = { shown: texts(approving), server: await serverTexts(threadId) };
    await approving.unmount();

    const queueing = await side.mount({ assistantId: "slow_graph", options: { stateKeys: [] } });
    void queueing.stream.submit(say("wait 800"));
    await queueing.until((s) => s.isLoading && s.threadId != null, "the first run");
    void queueing.stream.submit(say("Queued"));
    const queueThread = queueing.stream.threadId!;
    await runsOf(queueThread, (runs) => runs.length === 2 && runs.every((run) => run.status === "success"));
    await queueing.until((s) => !s.isLoading && s.messages.length === 4, "both runs");
    const queued = { shown: texts(queueing), server: await serverTexts(queueThread) };

    const watching = await side.mount({ assistantId: "stategraph_text", threadId, options: { stateKeys: [] } });
    await watching.until((s) => !s.isThreadLoading && s.messages.length === 4, "the thread");
    await client.runs.create(threadId, "stategraph_text", {
      input: say("Values only"),
      streamMode: ["values"],
      streamResumable: true,
    });
    await watching.until((s) => s.isLoading, "the values-only run");
    await watching.until((s) => !s.isLoading && s.messages.length === 6, "its answer");

    return {
      runModes: side.requests
        .filter((r) => r.method === "POST" && /\/runs(\/stream)?$/.test(r.path.split("?")[0]))
        .map((r) => (r.body as { stream_mode?: string[] }).stream_mode ?? []),
      answered,
      queued,
      valuesOnly: { shown: texts(watching), server: await serverTexts(threadId) },
    };
  });

  expect(shown.runModes, "a run, its answer, a run and the one queued behind it").toHaveLength(4);
  for (const modes of shown.runModes) {
    expect(modes).toEqual(expect.arrayContaining(["updates", "messages-tuple"]));
    expect(modes).not.toContain("values");
  }
  for (const flow of [shown.answered, shown.queued, shown.valuesOnly]) {
    expect(flow.shown).toEqual(flow.server);
  }
  expect(shown.valuesOnly.shown.slice(-2)).toEqual(["Values only", "Plan accepted."]);
});

it("a failing run sets error and its callbacks, a reload shows it, and the next run clears it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { thread_id: threadId } = await client.threads.create();
    const probe = await side.mount({ assistantId: "error_graph", threadId });
    await probe.until((s) => !s.isThreadLoading, "the thread");
    const threadErrors: unknown[] = [];
    probe.stream.getThread()?.onError((error: unknown) => threadErrors.push(error));
    const submitErrors: unknown[] = [];
    await probe.stream
      .submit(say("fail"), { onError: (error: unknown) => submitErrors.push(error) })
      .catch(() => undefined);
    const failed = await summary(probe);

    const reloaded = await side.mount({ assistantId: "error_graph", threadId });
    await reloaded.until((s) => !s.isThreadLoading, "the reloaded thread");
    const afterReload = await summary(reloaded);
    await reloaded.unmount();

    await probe.stream.submit(say("recover"));
    const recovered = await summary(probe);
    return {
      failed,
      afterReload: afterReload.final.error,
      recovered,
      submitErrors: submitErrors.length,
      threadErrors: threadErrors.length,
    };
  });

  expectSameSummary(v1.failed, v2.failed);
  expect(v2.failed.final.error).toContain("Intentional error for testing");
  expect(v2.failed.callbacks.at(-1)).toEqual(["onCompleted", expect.objectContaining({ reason: "error" })]);
  expectSameSummary(v1.recovered, v2.recovered);
  expect(v2.recovered.final.error).toBeNull();
  expect(v2.submitErrors).toBe(v1.submitErrors);
  expect(v1.threadErrors, is("threadOnErrorOnRunErrors")).toBe(0);
  expect(v2.threadErrors, is("threadOnErrorOnRunErrors")).toBe(1);
  expect(v1.afterReload, is("errorAfterLoad")).toBeNull();
  expect(v2.afterReload, is("errorAfterLoad")).toContain("Intentional error for testing");
});

const ended = (runs: { status: string }[]) =>
  runs.length > 0 && runs.every((run) => run.status !== "pending" && run.status !== "running");

it("stop() mid-run cancels the server run and reports stopped", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "slow_graph" });
    const submitted = probe.stream.submit(say("wait 1500")).catch(() => undefined);
    await probe.until(
      () => probe.calls.some(([name]) => name === "onCreated"),
      "the run to start"
    );
    await probe.stream.stop();
    await submitted;
    const threadId = probe.stream.threadId!;
    const runs = await runsOf(threadId, ended);
    return { summary: await summary(probe), runs: runs.map((run) => run.status) };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["callbacks", "loading"],
    because: ["stoppedRunReadsAsInterrupt", "stopBlinksLoading"],
  });
  expect(v1.runs).toEqual(["interrupted"]);
  expect(v2.runs).toEqual(["interrupted"]);
  expect(v1.summary.callbacks.at(-1), v1Bug("stoppedRunReadsAsInterrupt")).toEqual([
    "onCompleted",
    expect.objectContaining({ reason: onJsServer ? "interrupt" : expect.stringMatching(/^(interrupt|stopped)$/) }),
  ]);
  expect(v2.summary.callbacks.at(-1)).toEqual([
    "onCompleted",
    expect.objectContaining({ reason: "stopped" }),
  ]);
  expect(texts(v2.summary)).toEqual(["wait 1500"]);
  expect(v2.summary.loading).toEqual([false, true, false]);
});

it("stop() right after submit() leaves no run going", async () => {
  const { v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "slow_graph" });
    const submitted = probe.stream.submit(say("wait 1500")).catch(() => undefined);
    await probe.stream.stop();
    await submitted;
    await probe.until((s) => !s.isLoading, "the stop");
    const threadId = probe.stream.threadId;
    const runs =
      threadId == null
        ? []
        : await runsOf(threadId, (all) => all.every((r) => r.status !== "pending" && r.status !== "running"));
    return { summary: await summary(probe), runs: runs.map((run) => run.status) };
  });

  expect(v2.runs.filter((status) => status === "success")).toEqual([]);
  expect(v2.summary.callbacks.at(-1)).toEqual([
    "onCompleted",
    expect.objectContaining({ reason: "stopped" }),
  ]);
});

it("stop() after respond() cancels the run the answer started, and the approval shows again", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "interrupt_graph" });
    await probe.stream.submit({ request: "send the report" });
    await probe.until((s) => s.interrupt != null, "the approval");
    await probe.stream.respond({ approved: true });
    await probe.stream.stop();
    const threadId = probe.stream.threadId!;
    const runs = await runsOf(threadId, ended);
    const answerRun = runs.find((run) => (run.kwargs as { command?: unknown })?.command != null);
    const state = await client.threads.getState(threadId);
    return {
      summary: await summary(probe),
      answerRun: answerRun?.status,
      serverWaits: (state.tasks ?? []).some((task) => (task.interrupts ?? []).length > 0),
    };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["callbacks", "final.interrupt", "final.interrupts", "final.valuesKeys"],
    because: ["answerRunsUntracked", "answerRunNotStopped", "valuesOnlyFromGraph"],
  });
  expect(v2.answerRun).toBe("interrupted");
  expect(v2.serverWaits).toBe(true);
  expect(v2.summary.callbacks.slice(-2)).toEqual([
    ["onCreated", expect.anything()],
    ["onCompleted", expect.objectContaining({ reason: "stopped" })],
  ]);
  expect(v2.summary.final.interrupt).not.toBeNull();
  if (!messagesOnly) expect(v1.summary.final.valuesKeys, is("valuesOnlyFromGraph")).toContain("messages");
  expect(v2.summary.final.valuesKeys, is("valuesOnlyFromGraph")).not.toContain("messages");
});

it("a reply cut off by stop() stays gone after the next turn and a reload", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "stategraph_text" });
    const first = probe.stream.submit(say("first")).catch(() => undefined);
    await probe.until(
      (s) => s.messages.some((m) => m.type === "ai" && m.text.length > 0),
      "the reply to start"
    );
    await probe.stream.stop();
    await first;
    const afterStop = await summary(probe);
    await probe.stream.submit(say("second"));
    const afterNextTurn = await summary(probe);
    const reloaded = await side.mount({ assistantId: "stategraph_text", threadId: probe.stream.threadId });
    await reloaded.until((s) => !s.isThreadLoading && s.messages.length > 0, "the reload");
    return { afterStop, afterNextTurn, afterReload: await summary(reloaded) };
  });

  expectSameSummary(v1.afterStop, v2.afterStop);
  expectSameSummary(v1.afterNextTurn, v2.afterNextTurn);
  expectSameSummary(v1.afterReload, v2.afterReload);
  expect(v2.afterReload.final.messages.map((m) => m.text)).toEqual(["first", "second", "Plan accepted."]);
});

it("stop() after a reload cancels the run on 2.0, and 1.x leaves it running", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await side.mount({ assistantId: "slow_graph" });
    void first.stream.submit(say("wait 6000")).catch(() => undefined);
    await first.until(() => first.calls.some(([name]) => name === "onCreated"), "the run");
    const threadId = first.stream.threadId!;
    first.stream.stop({ cancel: false });
    await first.unmount();
    const reloaded = await side.mount({ assistantId: "slow_graph", threadId });
    await reloaded.until((s) => !s.isThreadLoading, "the reload");
    await reloaded.stream.stop();
    const runs = await runsOf(threadId, ended);
    return runs.map((run) => run.status);
  });

  expect(v1, is("stopCancelsAnyShownRun")).toEqual(["success"]);
  expect(v2, is("stopCancelsAnyShownRun")).toEqual(["interrupted"]);
});

it("disconnect() leaves the run going, and a remount shows its answer with no joinStream", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await side.mount({ assistantId: "slow_graph" });
    void first.stream.submit(say("wait 1000")).catch(() => undefined);
    await first.until(() => first.calls.some(([name]) => name === "onCreated"), "the run");
    const threadId = first.stream.threadId!;
    await first.stream.disconnect();
    await first.unmount();
    const runs = await runsOf(threadId, ended);
    const remounted = await side.mount({ assistantId: "slow_graph", threadId });
    await remounted.until((s) => s.messages.some((m) => m.text === "Done."), "the answer");
    return { runs: runs.map((run) => run.status), remounted: await summary(remounted) };
  });

  expect(v1.runs).toEqual(["success"]);
  expect(v2.runs).toEqual(["success"]);
  expectSameSummary(v1.remounted, v2.remounted);
});

it("a second hook mounted mid-run shows the run live and its answer", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await side.mount({ assistantId: "slow_graph" });
    const submitted = first.stream.submit(say("wait 1500")).catch(() => undefined);
    await first.until(() => first.calls.some(([name]) => name === "onCreated"), "the run");
    const second = await side.mount({ assistantId: "slow_graph", threadId: first.stream.threadId });
    await submitted;
    await runsOf(first.stream.threadId!, ended);
    return summary(second);
  });

  expect(texts(v2)).toEqual(["wait 1500", "Done."]);
  expect(v2.loading).toContain(true);
  expect(v2.callbacks).toEqual([
    ["onCompleted", expect.objectContaining({ runId: expect.any(String), reason: "success" })],
  ]);
  if (v1.loading.includes(true)) {
    expectSameSummary(v1, v2, { fields: ["callbacks"], because: ["joinedRunCompletedWithId"] });
  }
});

it("opening a thread while a run streams never shows fewer messages than the thread had", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { thread_id: threadId } = await client.threads.create();
    for (const content of ["one", "two"]) {
      await client.runs.wait(threadId, "slow_graph", { input: say(content) });
    }
    await client.runs.create(threadId, "slow_graph", { input: say("wait 1500") });
    const probe = await side.mount({ assistantId: "slow_graph", threadId });
    await probe.until((s) => s.messages.length >= 4, "the earlier turns");
    await runsOf(threadId, ended);
    const done = await summary(probe);
    const counts = probe.trace.map((s) => s.messages.length);
    const firstShown = counts.findIndex((count) => count >= 4);
    return { summary: done, rewound: counts.slice(firstShown).some((count) => count < 4) };
  });

  expect(v1.rewound).toBe(false);
  expect(v2.rewound).toBe(false);
  expect(texts(v2.summary)).toEqual(["one", "Done.", "two", "Done.", "wait 1500", "Done."]);
  if (texts(v1.summary).length === 6) {
    expectSameSummary(v1.summary, v2.summary, { fields: ["callbacks"], because: ["joinedRunCompletedWithId"] });
  }
});

itOnAgentServer("a remount mid-run rejoins the run without a rewind", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await side.mount({ assistantId: "deep_agent" });
    void first.stream.submit(say("Research and analyze")).catch(() => undefined);
    await first.until((s) => [...s.subagents.values()].some((sub) => sub.status === "running"), "the subagents");
    const threadId = first.stream.threadId!;
    await first.unmount();
    const remounted = await side.mount({ assistantId: "deep_agent", threadId });
    const runs = await runsOf(threadId, ended);
    if (side.name === "2.0") await remounted.until((s) => !s.isLoading && s.messages.length === 5, "the answer");
    const done = await summary(remounted);
    const counts = remounted.trace.map((s) => s.messages.length);
    return { summary: done, run: runs[0].status, rewound: counts.some((count, i) => count < counts[i - 1]) };
  });

  if (v1.summary.loading.includes(true)) {
    expectSameSummary(v1.summary, v2.summary, {
      fields: ["callbacks", "final.subagents", "final.toolCalls"],
      because: ["joinedRunCompletedWithId", "subagentOutputIsText", "rootToolCallsListSubagents", "commandOutputShownRaw"],
    });
  }
  expect(v2.summary.loading).toEqual([false, true, false]);
  for (const side of [v1, v2]) {
    expect(side.run).toBe("success");
    expect(side.rewound).toBe(false);
  }
});
