import { AIMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";

import { is, v1Bug } from "./differences.js";
import {
  client,
  expectSameSummary,
  interruptSaved,
  itOnAgentServer,
  onBothSides,
  onJsServer,
  onSide,
  runsOf,
  summary,
  type Summary,
} from "./harness.js";

const ended = (runs: { status: string }[]) =>
  runs.length > 0 && runs.every((run) => run.status !== "pending" && run.status !== "running");
const answerRuns = (runs: { kwargs?: unknown }[]) =>
  runs.filter((run) => (run.kwargs as { command?: unknown } | undefined)?.command != null);

it("an approval shows with its id, respond() resumes it before the run ends, and no card comes back", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "interrupt_graph" });
    await probe.stream.submit({ request: "send the report" });
    await probe.until((s) => s.interrupt != null, "the approval");
    const threadId = probe.stream.threadId!;
    const answeredAt = probe.trace.length;
    await probe.stream.respond({ approved: true });
    const [answer] = answerRuns(await client.runs.list(threadId));
    await runsOf(threadId, ended);
    const done = await summary(probe);
    return {
      summary: done,
      answerRunWhenRespondResolved: answer?.status,
      cardCameBack: probe.trace.slice(answeredAt).some((s, i, all) => s.interrupt == null && all.slice(i).some((later) => later.interrupt != null)),
    };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["final.valuesKeys", "callbacks", "loading"],
    because: ["valuesOnlyFromGraph", "answerRunsUntracked"],
  });
  expect(v2.summary.final.interrupt).toBeNull();
  for (const side of [v1, v2]) {
    expect(["pending", "running"]).toContain(side.answerRunWhenRespondResolved);
    expect(side.cardCameBack).toBe(false);
  }
});

it("an approval answered once doesn't show again after a reload or on the next run", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const answered = await side.mount({ assistantId: "interrupt_once_graph" });
    await answered.stream.submit({ request: "send the report" });
    await answered.until((s) => s.interrupt != null, "the approval");
    await answered.stream.respond({ approved: true });
    const threadId = answered.stream.threadId!;
    await runsOf(threadId, ended);
    await answered.unmount();
    const probe = await side.mount({ assistantId: "interrupt_once_graph", threadId });
    await probe.until((s) => !s.isThreadLoading, "the thread");
    const answeredAt = 0;
    await probe.stream.submit({ request: "send it again" });
    await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 3);
    await probe.until((s) => !s.isLoading, "the stream to settle");
    const done = await summary(probe);
    return { summary: done, shownAgain: probe.trace.slice(answeredAt).some((s) => s.interrupt != null) };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["final.valuesKeys", "callbacks", "loading"],
    because: ["valuesOnlyFromGraph", "answerRunsUntracked"],
  });
  expect(v1.shownAgain).toBe(false);
  expect(v2.shownAgain).toBe(false);
});

it("respondAll() answers parallel approvals in one run, and respond() by id answers just that one", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const all = await side.mount({ assistantId: "multi_interrupt_graph" });
    await all.stream.submit({ prompts: ["a", "b"] });
    await all.until((s) => s.interrupts.length === 2, "two approvals");
    const ids = all.stream.interrupts.map((i) => i.id!);
    await all.stream.respondAll(Object.fromEntries(ids.map((id) => [id, { approved: true }])), {
      metadata: { answeredBy: "parity" },
    });
    const allRuns = await runsOf(all.stream.threadId!, (runs) => ended(runs) && runs.length === 2);

    const one = await side.mount({ assistantId: "multi_interrupt_graph" });
    await one.stream.submit({ prompts: ["c", "d"] });
    await one.until((s) => s.interrupts.length === 2, "two approvals");
    const [first, second] = one.stream.interrupts.map((i) => i.id!);
    await one.stream.respond({ approved: true }, { interruptId: second });
    await runsOf(one.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
    await one.until((s) => s.interrupts.length === 1, "one approval left");
    const left = one.stream.interrupts.map((i) => i.id);
    await one.stream.respond({ approved: true }, { interruptId: first });
    await runsOf(one.stream.threadId!, (runs) => ended(runs) && runs.length === 3);
    await one.until((s) => !s.isLoading, "the stream to settle");

    return {
      all: await summary(all),
      allMetadata: (answerRuns(allRuns)[0] as { metadata?: Record<string, unknown> }).metadata?.answeredBy,
      leftAfterOne: left.map((id) => (id === first ? "first" : "other")),
      one: await summary(one),
    };
  });

  for (const key of ["all", "one"] as const) {
    expectSameSummary(v1[key], v2[key], {
      fields: ["final.valuesKeys", "callbacks", "loading"],
      because: ["valuesOnlyFromGraph", "answerRunsUntracked"],
    });
  }
  expect(v2.all.final.interrupts).toEqual([]);
  expect(v2.allMetadata).toBe("parity");
  expect(v1.allMetadata).toBe("parity");
  expect(v1.leftAfterOne).toEqual(["first"]);
  expect(v2.leftAfterOne).toEqual(["first"]);
});

it("respond() with no id answers the approval stream.interrupt shows on 2.0", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "multi_interrupt_graph" });
    await probe.stream.submit({ prompts: ["a", "b"] });
    await probe.until((s) => s.interrupts.length === 2, "two approvals");
    const shown = probe.stream.interrupt!.id;
    const other = probe.stream.interrupts.find((i) => i.id !== shown)!.id;
    await probe.stream.respond({ approved: true });
    await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
    await probe.until((s) => s.interrupts.length === 1, "one approval left");
    return probe.stream.interrupts[0].id === other ? "answered the shown one" : "answered the other one";
  });

  expect(v2, is("respondWithoutId")).toBe("answered the shown one");
  expect(["answered the shown one", "answered the other one"]).toContain(v1);
});

it("an answer with a state update keeps the card in the conversation through the slow tool, approved or rejected", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const outcomes: Record<string, { summary: Summary; cardFlickered: boolean }> = {};
    for (const approved of [true, false]) {
      const probe = await side.mount({ assistantId: "interrupt_card_graph" });
      await probe.stream.submit({ toolArg: "delete_db" });
      await probe.until((s) => s.interrupt != null, "the card");
      const value = probe.stream.interrupt!.value as { content: string; response_metadata: unknown };
      const answeredAt = probe.trace.length;
      await probe.stream.respond(
        { approved },
        {
          update: {
            messages: [new AIMessage({ content: value.content, response_metadata: value.response_metadata as Record<string, unknown> })],
          },
        }
      );
      await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
      const done = await summary(probe);
      const cards = probe.trace.slice(answeredAt).map((s) => s.messages.filter((m) => m.text.startsWith("Please review")).length);
      outcomes[approved ? "approved" : "rejected"] = {
        summary: done,
        cardFlickered: cards.slice(cards.indexOf(1)).some((count) => count !== 1),
      };
      await probe.unmount();
    }
    return outcomes;
  });

  for (const outcome of ["approved", "rejected"]) {
    expectSameSummary(v1[outcome].summary, v2[outcome].summary, {
      fields: ["callbacks", "loading"],
      because: ["answerRunsUntracked"],
    });
    expect(v1[outcome].cardFlickered, outcome).toBe(false);
    expect(v2[outcome].cardFlickered, outcome).toBe(false);
  }
  expect(v2.approved.summary.final.messages.map((m) => m.text)).toContain('Executed "delete_db".');
  expect(v2.rejected.summary.final.messages.map((m) => m.text)).toContain("User has rejected the toolcall");
});

it("a nested approval has its namespace, shows again after a reload, getThread() lists it, and an answer by id resumes it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await side.mount({ assistantId: "nested_interrupt_graph" });
    await first.stream.submit({ request: "nested" });
    await first.until((s) => s.interrupt != null, "the nested approval");
    const shownId = first.stream.interrupt!.id;
    await interruptSaved(first.stream.threadId!);
    await first.unmount();
    const probe = await side.mount({ assistantId: "nested_interrupt_graph", threadId: first.stream.threadId });
    await probe.until(
      (s) => s.interrupt?.id === shownId && (s.getThread()?.interrupts.length ?? 0) > 0,
      "the nested approval after a reload"
    );
    const listed = probe.stream.getThread()?.interrupts.map((i) => ({
      isShown: i.interruptId === shownId,
      namespace: i.namespace.map((part) => part.split(":")[0]),
    }));
    await probe.stream.respond({ approved: true }, { interruptId: probe.stream.interrupt!.id });
    await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
    return { summary: await summary(probe), listed };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["final.valuesKeys", "callbacks", "loading"],
    because: ["valuesOnlyFromGraph", "answerRunsUntracked"],
  });
  expect(v1.listed, is("nestedNamespaceAfterLoad")).toEqual([{ isShown: true, namespace: ["child", "inner"] }]);
  expect(v2.listed, is("nestedNamespaceAfterLoad")).toEqual([{ isShown: true, namespace: ["child"] }]);
  expect(v2.summary.final.interrupt).toBeNull();
});

it("a subagent's approval in a deep agent is answered by id and the agent finishes", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "deep_agent_interrupt" });
    await probe.stream.submit({ messages: [{ type: "human", content: "Change it" }] });
    await probe.until((s) => s.interrupt != null, "the subagent's approval");
    const listed = probe.stream.getThread()?.interrupts.length;
    await probe.stream.respond({ approved: true }, { interruptId: probe.stream.interrupt!.id });
    await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
    return { summary: await summary(probe), listed };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["callbacks", "loading", "final.subagents", ...(onJsServer ? [] : ["final.toolCalls"])],
    because: ["answerRunsUntracked", "subagentOutputIsText", "rootToolCallsListSubagents", "commandOutputShownRaw"],
  });
  const output = (s: Summary) => (s.final.subagents as { output: unknown }[])[0]?.output;
  expect(output(v1.summary), is("subagentOutputIsText")).toEqual(
    expect.objectContaining({ type: "tool", content: "Approval recorded." })
  );
  expect(output(v2.summary), is("subagentOutputIsText")).toBe("Approval recorded.");
  expect(v2.listed).toBe(v1.listed);
  expect(v2.summary.final.messages.at(-1)?.text).toBe("Subagent approval completed.");
});

it("a plain submit while two approvals wait runs its new input, and its approval replaces theirs", async () => {
  const result = await onSide("2.0", async (side) => {
    const probe = await side.mount({ assistantId: "multi_interrupt_graph" });
    await probe.stream.submit({ prompts: ["a", "b"] });
    await probe.until((s) => s.interrupts.length === 2, "two approvals");
    await probe.stream.submit({ prompts: ["c"] });
    await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2);
    await probe.until((s) => !s.isLoading, "the second run");
    return probe.stream.interrupts.map((i) => (i.value as { action: string }).action);
  });

  expect(result, v1Bug("plainSubmitWhileWaitingLost")).toEqual(["c"]);
});

it("respond() sends its update and goto with the answer", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "interrupt_graph" });
    await probe.stream.submit({ request: "send the report" });
    await probe.until((s) => s.interrupt != null, "the approval");
    await probe.stream.respond({ approved: true }, { update: { request: "send it now" }, goto: "__end__" } as never);
    const [answer] = answerRuns(await runsOf(probe.stream.threadId!, (runs) => ended(runs) && runs.length === 2));
    await probe.until((s) => !s.isLoading, "the answer's run");
    const { resume, ...command } = (answer.kwargs as { command: { resume: Record<string, unknown> } }).command;
    return {
      command: { ...command, resume: Object.values(resume) },
      values: (await client.threads.getState(probe.stream.threadId!)).values,
    };
  });

  expect(v2).toEqual(v1);
  expect(v2.command).toEqual({ resume: [{ approved: true }], update: { request: "send it now" }, goto: "__end__" });
});

itOnAgentServer("an approval another hook answers goes away, and a late answer to it fails its run on 2.0", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const answering = await side.mount({ assistantId: "interrupt_graph" });
    await answering.stream.submit({ request: "send the report" });
    await answering.until((s) => s.interrupt != null, "the approval");
    const threadId = answering.stream.threadId!;
    await interruptSaved(threadId);
    const watching = await side.mount({ assistantId: "interrupt_graph", threadId });
    await watching.until((s) => s.interrupt != null, "the approval on the other hook");
    const card = watching.stream.interrupt!.id!;
    await answering.stream.respond({ approved: true });
    await runsOf(threadId, (runs) => ended(runs) && runs.length === 2);
    const answered = await summary(watching);
    const lateAnswer = await watching.stream.respond({ approved: false }, { interruptId: card }).then(
      () => "sent",
      (error: Error) => error.message
    );
    const late = await summary(watching);
    const runs = await runsOf(threadId, ended);
    return {
      answered,
      lateAnswer,
      late,
      runs: [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((run) => run.status),
      values: (await client.threads.getState(threadId)).values,
    };
  });

  expectSameSummary(v1.answered, v2.answered, {
    fields: ["final.valuesKeys", "callbacks", "loading"],
    because: ["valuesOnlyFromGraph", "pausedThreadBlinksLoading", "joinedRunCompletedWithId"],
  });
  expect(v2.answered.final.interrupt).toBeNull();
  expect(v1.lateAnswer, is("lateAnswerFails")).toMatch(/Unknown or already-consumed interrupt/);
  expect(v1.runs, is("lateAnswerFails")).toEqual(["success", "success"]);
  expect(v2.runs, is("lateAnswerFails")).toEqual(["success", "success", "error"]);
  expect(v2.late.final.error, is("lateAnswerFails")).toMatch(/Unknown or already-consumed interrupt/);
  for (const side of [v1, v2]) {
    expect(side.values).toEqual({ request: "send the report", decision: { approved: true }, completed: true });
  }
});
