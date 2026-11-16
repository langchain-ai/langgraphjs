import { Client } from "@langchain/langgraph-sdk";
import { expect, it, vi } from "vitest";

import { is } from "./differences.js";
import {
  apiUrl,
  client,
  expectSameSummary,
  hydrateOn,
  itOnAgentServer,
  onBothSides,
  onJsServer,
  onSide,
  resumeTtl,
  runsOf,
  summary,
  wire,
  type Summary,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const texts = (s: Summary) => s.final.messages.map((m) => m.text);
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count && runs.every((run) => run.status !== "pending" && run.status !== "running");

async function threadWith(...turns: string[]) {
  const { thread_id: threadId } = await client.threads.create();
  for (const content of turns) {
    await client.runs.wait(threadId, "stategraph_text", { input: say(content) });
  }
  return threadId;
}

it("opening a thread shows its messages once loaded, and re-renders don't read it again", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const threadId = await threadWith("Hello");
    const headers = () => ({ options: { defaultHeaders: { "x-render": "same" } } });
    const probe = await side.mount({ assistantId: "stategraph_text", threadId, ...headers() });
    await probe.stream.hydrationPromise;
    await probe.until((s) => !s.isThreadLoading && s.messages.length === 2, "the thread");
    const opened = await summary(probe);
    for (let i = 0; i < 3; i += 1) {
      await probe.rerender(headers());
    }
    await summary(probe);
    return {
      opened,
      stateReads: wire(side.requests).filter((r) => r === "GET /threads/:id/state").length,
    };
  });

  expectSameSummary(v1.opened, v2.opened);
  expect(texts(v2.opened)).toEqual(["Hello", "Plan accepted."]);
  expect(v2.stateReads, is("inlineHeadersKeepClient")).toBe(1);
  expect(v1.stateReads, is("inlineHeadersKeepClient")).toBeGreaterThan(1);
});

it("a threadId change shows the new thread with nothing from the old one, and null clears it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const first = await threadWith("First thread");
    const second = await threadWith("Second thread");
    const probe = await side.mount({ assistantId: "stategraph_text", threadId: first });
    await probe.until((s) => s.messages.length === 2, "the first thread");
    await probe.rerender({ threadId: second });
    await probe.until((s) => s.messages[0]?.text === "Second thread", "the second thread");
    const leaked = probe.trace.some(
      (s) => s.threadId === second && s.messages.some((m) => m.text === "First thread")
    );
    const switched = await summary(probe);
    await probe.rerender({ threadId: null });
    await probe.until((s) => s.threadId == null, "no thread");
    await summary(probe);
    return {
      summary: switched,
      leaked,
      cleared: { threadId: probe.stream.threadId, messages: probe.stream.messages.length },
    };
  });

  expectSameSummary(v1.summary, v2.summary, {
    fields: ["callbacks"],
    because: ["onThreadIdOnEveryChange"],
  });
  expect(v1.leaked).toBe(false);
  expect(v2.leaked).toBe(false);
  expect(v1.cleared).toEqual({ threadId: null, messages: 0 });
  expect(v2.cleared).toEqual({ threadId: null, messages: 0 });
  expect(v1.summary.callbacks, is("onThreadIdOnEveryChange")).toEqual([]);
  expect(v2.summary.callbacks, is("onThreadIdOnEveryChange")).toEqual([["onThreadId", "id#0"]]);
});

it("submit({ threadId }) runs on a thread made beforehand, and an id made in the browser is created by its first submit", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const made = await threadWith();
    const probe = await side.mount({ assistantId: "stategraph_text" });
    await probe.stream.submit(say("On the made thread"), { threadId: made });
    await probe.until((s) => s.threadId === made && s.messages.length === 2, "the run");
    const onMade = await summary(probe);
    await probe.unmount();

    const minted = crypto.randomUUID();
    const fresh = await side.mount({ assistantId: "stategraph_text", threadId: minted });
    await fresh.until((s) => !s.isThreadLoading, "the empty thread");
    const beforeSubmit = { error: fresh.stream.error ?? null, messages: fresh.stream.messages.length };
    await fresh.stream.submit(say("On a new id"));
    await fresh.until((s) => s.messages.length === 2, "the run");
    const exists = (await client.threads.get(minted)).thread_id === minted;
    return { onMade, beforeSubmit, exists, minted: await summary(fresh) };
  });

  expectSameSummary(v1.onMade, v2.onMade, {
    fields: ["callbacks"],
    because: ["onThreadIdOnEveryChange"],
  });
  expectSameSummary(v1.minted, v2.minted);
  for (const side of [v1, v2]) {
    expect(side.beforeSubmit).toEqual({ error: null, messages: 0 });
    expect(side.exists).toBe(true);
  }
});

it("defaultHeaders reach every request, and a passed client's onRequest sees its requests", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const headed = await side.mount({
      assistantId: "stategraph_text",
      options: { defaultHeaders: { "x-parity": "yes" } },
    });
    await headed.stream.submit(say("Hello"));
    await summary(headed);
    const withoutHeader = side.requests
      .filter((r) => r.headers["x-parity"] !== "yes")
      .map((r) => `${r.method} ${r.path.split("?")[0].replace(/[0-9a-f-]{36}/g, ":id")}`);
    await headed.unmount();

    const seen: string[] = [];
    const ownClient = new Client({
      apiUrl,
      onRequest: (url, init) => {
        seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
        return init;
      },
    });
    const passed = await side.mount({ assistantId: "stategraph_text", options: { client: ownClient } });
    await passed.stream.submit(say("Hello"));
    await summary(passed);
    return { withoutHeader, onRequestCalls: seen.length, isOwnClient: passed.stream.client === ownClient };
  });

  expect(v2.withoutHeader).toEqual([]);
  expect(v1.withoutHeader).toEqual([]);
  expect(v2.onRequestCalls).toBeGreaterThan(0);
  expect(v1.onRequestCalls).toBeGreaterThan(0);
  expect(v1.isOwnClient).toBe(true);
  expect(v2.isOwnClient).toBe(true);
});

it("fetch carries the stream on 1.x and every request on 2.0, and with a passed client 2.0 ignores it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    let calls = 0;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return globalThis.fetch(input, init);
    };
    const threadId = await threadWith("Hello");
    const own = await side.mount({ assistantId: "stategraph_text", threadId, options: { fetch } });
    await own.until((s) => s.messages.length === 2, "the thread");
    await own.stream.submit(say("Again"));
    await summary(own);
    const throughFetch = calls;
    const allRequests = side.requests.length;
    await own.unmount();

    calls = 0;
    const withClient = await side.mount({
      assistantId: "stategraph_text",
      options: { fetch, client: new Client({ apiUrl }) },
    });
    await withClient.stream.submit(say("Hello"));
    await summary(withClient);
    return { throughFetch, allRequests, throughFetchWithClient: calls };
  });

  expect(v2.throughFetch, is("fetch")).toBe(v2.allRequests);
  expect(v1.throughFetch, is("fetch")).toBeLessThan(v1.allRequests);
  expect(v2.throughFetchWithClient, is("fetch")).toBe(0);
});

it("submit() sends its config and metadata with the run", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "stategraph_text" });
    await probe.stream.submit(say("Hello"), {
      config: { configurable: { parity: "config" } },
      metadata: { parity: "metadata" },
    });
    const [run] = await runsOf(probe.stream.threadId!, ended(1));
    return {
      configurable: (run.kwargs as { config?: { configurable?: Record<string, unknown> } }).config?.configurable?.parity,
      metadata: (run.metadata as Record<string, unknown>).parity,
    };
  });

  expect(v1).toEqual({ configurable: "config", metadata: "metadata" });
  expect(v2).toEqual(v1);
});

it("callbacks come from the latest render on 2.0, and its functions keep their identity", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const seenFrom: number[] = [];
    let submitKept = true;
    let previousSubmit: unknown;
    const optionsFor = (render: number) => ({ onCreated: () => seenFrom.push(render) });
    const probe = await side.mount({
      assistantId: "stategraph_text",
      options: optionsFor(1),
      extra: (stream) => {
        if (previousSubmit != null && previousSubmit !== stream.submit) submitKept = false;
        previousSubmit = stream.submit;
        return null;
      },
    });
    await probe.rerender({ options: optionsFor(2) });
    await probe.rerender({ options: optionsFor(3) });
    await probe.stream.submit(say("Hello"));
    await summary(probe);
    return { seenFrom, submitKept };
  });

  expect(v1.seenFrom, is("callbacksFromLatestRender")).toEqual([1]);
  expect(v2.seenFrom, is("callbacksFromLatestRender")).toEqual([3]);
  expect(v1.submitKept, is("stableFunctions")).toBe(false);
  expect(v2.submitKept, is("stableFunctions")).toBe(true);
});

it("hydrate() shows another client's run, and joins a run it finds running", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const threadId = await threadWith("Hello");
    const probe = await side.mount({ assistantId: "slow_graph", threadId });
    await probe.until((s) => s.messages.length === 2, "the thread");
    const hydrate = () => hydrateOn(side, probe);

    await client.runs.wait(threadId, "slow_graph", { input: say("From elsewhere") });
    await hydrate();
    await probe.until((s) => s.messages.length === 4, "the other run's messages");
    const afterOtherRun = await summary(probe);

    await client.runs.create(threadId, "slow_graph", { input: say("wait 1500") });
    await hydrate();
    await runsOf(threadId, ended(3));
    return { afterOtherRun, joined: await summary(probe), wasLoading: probe.trace.some((s) => s.isLoading) };
  });

  expectSameSummary(v1.afterOtherRun, v2.afterOtherRun, {
    fields: ["threadLoading", ...(onJsServer ? [] : ["loading", "callbacks"])],
    because: ["quietSameThreadHydrate", "runsStartedElsewhere"],
  });
  expect(v1.afterOtherRun.loading).toEqual([false]);
  expect(v2.afterOtherRun.loading, is("runsStartedElsewhere")).toEqual(onJsServer ? [false] : [false, true, false]);
  expect(v1.afterOtherRun.threadLoading, is("quietSameThreadHydrate")).toEqual([true, false, true, false]);
  expect(v2.afterOtherRun.threadLoading, is("quietSameThreadHydrate")).toEqual([true, false]);
  expect(v2.wasLoading).toBe(true);
  expect(texts(v2.joined)).toEqual(["Hello", "Plan accepted.", "From elsewhere", "Done.", "wait 1500", "Done."]);
  if (texts(v1.joined).length === 6) {
    expectSameSummary(v1.joined, v2.joined, {
      fields: ["callbacks", "threadLoading"],
      because: ["joinedRunCompletedWithId", "quietSameThreadHydrate"],
    });
  }
});

itOnAgentServer("a run another hook on the thread starts shows live and final on 2.0", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const threadId = await threadWith("Hello");
    const watching = await side.mount({ assistantId: "stategraph_text", threadId });
    await watching.until((s) => !s.isThreadLoading && s.messages.length === 2, "the thread");
    const sending = await side.mount({ assistantId: "stategraph_text", threadId });
    await sending.until((s) => !s.isThreadLoading && s.messages.length === 2, "the other hook's thread");
    await sending.stream.submit(say("From the other hook"));
    await runsOf(threadId, ended(2));
    return summary(watching);
  });

  expect(texts(v1), is("runsStartedElsewhere")).toEqual(["Hello", "Plan accepted."]);
  expect(texts(v2), is("runsStartedElsewhere")).toEqual([
    "Hello",
    "Plan accepted.",
    "From the other hook",
    "Plan accepted.",
  ]);
  expect(v2.loading).toEqual([false, true, false]);
  expect(v2.streamedInParts).toBe(true);
});

function setVisibility(state: "hidden" | "visible") {
  if (state === "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
  document.dispatchEvent(new Event("visibilitychange"));
}

const HIDDEN_PAGE_ROWS = [
  { seenLive: false, name: "a page hidden right after its own run shows a run another client ran meanwhile when it shows again" },
  {
    seenLive: true,
    name: "a page whose thread stream saw a run shows a run another client ran while it was hidden, from the replay, or by reading the thread once the resume point is gone",
  },
];

for (const { seenLive, name } of HIDDEN_PAGE_ROWS) {
  itOnAgentServer(name, async () => {
    const shown = await onSide("2.0", async (side) => {
      const watching = () => [...side.open].some((key) => /^GET \/threads\/[^/]+\/stream#/.test(key));
      const reads = () => side.requests.filter((r) => r.method === "GET" && /\/(state|history)/.test(r.path)).length;
      const probe = await side.mount({ assistantId: "stategraph_text" });
      await probe.stream.submit(say("Hello"));
      await probe.until((s) => !s.isLoading && s.messages.length === 2, "the run");
      const threadId = probe.stream.threadId!;
      await vi.waitFor(() => expect(watching(), "the thread stream").toBe(true), { timeout: 10_000 });
      if (seenLive) {
        await client.runs.wait(threadId, "stategraph_text", { input: say("Seen live") });
        await probe.until((s) => !s.isLoading && s.messages.length === 4, "the run seen live");
      }
      try {
        setVisibility("hidden");
        await vi.waitFor(() => expect(watching(), "the thread stream closed").toBe(false), { timeout: 10_000 });
        await client.runs.wait(threadId, "stategraph_text", { input: say("While hidden") });
        await new Promise((resolve) => setTimeout(resolve, resumeTtl > 0 ? (resumeTtl + 2) * 1000 : 500));
        const readsBefore = reads();
        setVisibility("visible");
        await probe.until((s) => s.messages.length === (seenLive ? 6 : 4), "the run that ran while hidden");
        return { last: probe.stream.messages.slice(-2).map((m) => m.text), reads: reads() - readsBefore };
      } finally {
        setVisibility("visible");
      }
    });

    expect(shown.last).toEqual(["While hidden", "Plan accepted."]);
    if (seenLive && resumeTtl > 0) {
      expect(shown.reads, "the server sends gap once the resume point is gone, and 2.0 reads the thread").toBeGreaterThan(0);
    }
  });
}
