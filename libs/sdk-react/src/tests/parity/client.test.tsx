import { Component, Suspense, type ReactNode } from "react";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { z } from "zod/v4";

import { is, v1Bug } from "./differences.js";
import {
  apiUrl,
  client,
  expectSameSummary,
  itOnJsServer,
  onBothSides,
  onSide,
  summary,
  type Hooks,
  type Probe,
  type Summary,
} from "./harness.js";

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const texts = (s: Summary) => s.final.messages.map((m) => m.text);
const extraOf = <T,>(probe: Probe) => probe.extra as T;

const getLocation = tool({
  name: "get_location",
  description: "Get the user's current GPS location",
  schema: z.object({ highAccuracy: z.boolean().optional() }),
});
const LOCATION = { latitude: 37.7749, longitude: -122.4194 };

it("useMessageMetadata gives the first message a fork point, and forkFrom branches there, also after a reload", async () => {
  const firstForkPoint = (stream: Probe["stream"], hooks: Hooks) => ({
    forkPoint: hooks.useMessageMetadata(stream, stream.messages[0]?.id)?.parentCheckpointId ?? null,
  });
  type Forks = { forkPoint: string | null; forked?: Summary; again?: Summary };
  const { v1, v2 } = await onBothSides(async (side): Promise<Forks> => {
    const probe = await side.mount({ assistantId: "stategraph_text", extra: firstForkPoint });
    await probe.stream.submit(say("Hello"));
    await probe.until((s) => !s.isLoading && s.messages.length === 2, "the run");
    await probe.until(() => extraOf<{ forkPoint: string | null }>(probe).forkPoint != null, "the fork point");
    const forkPoint = extraOf<{ forkPoint: string }>(probe).forkPoint;
    await probe.stream.submit(say("Edited"), { forkFrom: forkPoint } as never);
    await probe.until((s) => !s.isLoading && s.messages[0]?.text === "Edited" && s.messages.length === 2, "the fork");
    const forked = await summary(probe);
    const threadId = probe.stream.threadId!;
    await probe.unmount();

    const reloaded = await side.mount({ assistantId: "stategraph_text", threadId, extra: firstForkPoint });
    await reloaded.until((s) => !s.isThreadLoading && s.messages.length === 2, "the thread");
    await reloaded.until(() => extraOf<{ forkPoint: string | null }>(reloaded).forkPoint != null, "the fork point");
    await reloaded.stream.submit(say("Again"), {
      forkFrom: extraOf<{ forkPoint: string }>(reloaded).forkPoint,
    } as never);
    await reloaded.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Plan accepted." && s.messages.some((m) => m.text === "Again"), "the second fork");
    return { forkPoint, forked, again: await summary(reloaded) };
  });

  expect(v2.forked!.loading).toEqual([false, true, false, true, false]);
  expect(texts(v2.forked!)).toEqual(["Edited", "Plan accepted."]);
  expect(texts(v2.again!), is("forkPointsAfterRun")).toEqual(["Again", "Plan accepted."]);
  expectSameSummary(v1.forked!, v2.forked!, { fields: ["loading"], because: ["forkLoadingFlickers"] });
  expect(texts(v1.again!), is("forkPointsAfterRun")).toEqual(["Edited", "Again", "Plan accepted."]);
});

itOnJsServer("a headless tool runs once in the browser under StrictMode, its result resumes the run, and its error reaches the agent", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const results: Record<string, unknown> = {};
    for (const [name, execute] of [
      ["succeeds", async () => LOCATION],
      ["fails", async () => Promise.reject(new Error("GPS unavailable"))],
    ] as const) {
      const run = vi.fn(execute);
      const events: string[] = [];
      const probe = await side.mount({
        assistantId: "headless_tool_graph",
        options: {
          tools: [getLocation.implement(run as never)],
          onTool: (event: { phase: string; name: string; result?: unknown; error?: Error }) =>
            events.push(
              [event.phase, event.name, event.result ? JSON.stringify(event.result) : event.error?.message]
                .filter(Boolean)
                .join(":")
            ),
        },
      });
      await probe.stream.submit(say("Where am I?"));
      await probe.until((s) => !s.isLoading && s.messages.at(-1)?.text === "Location received!", "the agent's answer");
      results[name] = { calls: run.mock.calls.length, events, summary: await summary(probe) };
      await probe.unmount();
    }
    return results as Record<"succeeds" | "fails", { calls: number; events: string[]; summary: Summary }>;
  });

  const reasons = (s: Summary) =>
    s.callbacks.filter(([name]) => name === "onCompleted").map(([, info]) => (info as { reason: string }).reason);
  for (const outcome of ["succeeds", "fails"] as const) {
    expectSameSummary(v1[outcome].summary, v2[outcome].summary, {
      fields: ["callbacks", "loading"],
      because: ["answerRunsUntracked"],
    });
    expect(v2[outcome].summary.loading).toEqual([false, true, false]);
    expect(reasons(v1[outcome].summary), v1Bug("answerRunsUntracked")).toEqual(["stopped"]);
    expect(reasons(v2[outcome].summary)).toEqual(["stopped", "success"]);
  }
  for (const side of [v1, v2]) {
    expect(side.succeeds.calls).toBe(1);
    expect(side.succeeds.events).toEqual(["start:get_location", `success:get_location:${JSON.stringify(LOCATION)}`]);
    expect(side.fails.events).toEqual(["start:get_location", "error:get_location:GPS unavailable"]);
    expect(side.succeeds.summary.final.interrupts).toEqual([]);
  }
});

itOnJsServer("a headless tool waiting on a thread runs once when the thread opens, and once more on the next thread", async () => {
  const waitingThread = async () => {
    const { thread_id } = await client.threads.create();
    await client.runs.wait(thread_id, "headless_tool_graph", { input: say("Where am I?") });
    return thread_id;
  };
  const answered = (threadId: string) => (s: Probe["stream"]) =>
    s.threadId === threadId && !s.isLoading && s.messages.at(-1)?.text === "Location received!";
  const result = await onSide("2.0", async (side) => {
    const [first, second] = [await waitingThread(), await waitingThread()];
    const run = vi.fn(async () => LOCATION);
    const probe = await side.mount({
      assistantId: "headless_tool_graph",
      threadId: first,
      options: { tools: [getLocation.implement(run as never)] },
    });
    await probe.until(answered(first), "the first thread's answer");
    const onFirst = run.mock.calls.length;
    await probe.rerender({ threadId: second });
    await probe.until(answered(second), "the second thread's answer");
    await summary(probe);
    return { onFirst, onBoth: run.mock.calls.length };
  });

  expect(result, v1Bug("waitingToolNeverAnswered")).toEqual({ onFirst: 1, onBoth: 2 });
});

interface Optimism {
  status: string;
  valuesStatus: string;
}

itOnJsServer("optimistic input shows at once as pending, is matched to the server's by id, and rolls back with a run that never starts", async () => {
  const optimism = (stream: Probe["stream"], hooks: Hooks): Optimism => ({
    status: hooks.useMessageMetadata(stream, stream.messages[0]?.id)?.optimisticStatus ?? "none",
    valuesStatus: (stream.values as { status?: string } | undefined)?.status ?? "none",
  });
  const cases = [
    ["sent", "slow_graph", say("Hello"), undefined],
    ["failed", "missing_graph", say("Hello"), undefined],
    ["off", "slow_graph", say("Hello"), false],
    ["values", "stateful_values_graph", { ...say("Hello"), status: "draft" }, undefined],
    ["valuesOff", "stateful_values_graph", { ...say("Hello"), status: "draft" }, false],
    ["valuesFailed", "missing_graph", { ...say("Hello"), status: "draft" }, undefined],
  ] as const;
  const { v1, v2 } = await onBothSides(async (side) => {
    const results: Partial<Record<(typeof cases)[number][0], Record<string, unknown> & { last: Optimism }>> = {};
    for (const [name, assistantId, input, optimistic] of cases) {
      const probe = await side.mount({ assistantId, options: { optimistic }, extra: optimism });
      await probe.stream.submit(input).catch(() => undefined);
      await probe.until((s) => !s.isLoading && (s.error != null || s.messages.length === 2), "the run");
      await summary(probe);
      const atStart = probe.trace.find((s) => s.isLoading)!;
      results[name] = {
        atStart: { messages: atStart.messages.length, valuesStatus: (atStart.extra as Optimism).valuesStatus },
        everPending: probe.trace.some((s) => (s.extra as Optimism).status === "pending"),
        last: extraOf<Optimism>(probe),
        texts: probe.stream.messages.map((m) => m.text),
        failed: probe.stream.error != null,
      };
      await probe.unmount();
    }
    return results as Required<typeof results>;
  });

  for (const [name] of cases) {
    const { last: _v1, ...v1Rest } = v1[name];
    const { last: _v2, ...v2Rest } = v2[name];
    expect(v2Rest, name).toEqual(v1Rest);
  }
  for (const name of ["sent", "off", "values", "valuesOff"] as const) {
    expect(v2[name].last, name).toEqual(v1[name].last);
  }
  expect(v2.sent).toEqual(expect.objectContaining({ atStart: { messages: 1, valuesStatus: "none" }, everPending: true, last: { status: "sent", valuesStatus: "none" }, texts: ["Hello", "Done."] }));
  expect(v2.off).toEqual(expect.objectContaining({ atStart: { messages: 0, valuesStatus: "none" }, everPending: false, last: { status: "none", valuesStatus: "none" } }));
  expect(v2.values).toEqual(expect.objectContaining({ atStart: { messages: 1, valuesStatus: "draft" }, last: { status: "sent", valuesStatus: "final" } }));
  expect(v2.valuesOff).toEqual(expect.objectContaining({ atStart: { messages: 0, valuesStatus: "none" }, last: { status: "none", valuesStatus: "final" } }));
  expect(v2.failed).toEqual(expect.objectContaining({ texts: ["Hello"], failed: true }));
  expect(v2.failed.last, v1Bug("failedSubmitShowsNoStatus")).toEqual({ status: "failed", valuesStatus: "none" });
  expect(v1.valuesFailed.last.valuesStatus).toBe("none");
  expect(v2.valuesFailed.last, "the optimistic value rolls back").toEqual({ status: "failed", valuesStatus: "none" });
});

const CACHED = [
  new HumanMessage({ id: "cached-1", content: "Cached user message" }),
  new AIMessage({ id: "cached-2", content: "Cached AI response" }),
];

async function threadWith(assistantId: string, content: string) {
  const { thread_id: threadId } = await client.threads.create();
  await client.runs.wait(threadId, assistantId, { input: say(content) });
  return threadId;
}

itOnJsServer("initialValues show until the thread loads or a run starts, and messagesKey reads the messages from its key", async () => {
  const shown = (probe: Probe) => ({
    texts: probe.stream.messages.map((m) => m.text),
    status: (probe.stream.values as { status?: string }).status ?? null,
  });
  const firstRender = (probe: Probe) => ({
    texts: probe.trace[0].messages.map((m) => m.text),
    status: (probe.trace[0].extra as { status: string | null }).status,
  });
  const status = (stream: Probe["stream"]) => ({ status: (stream.values as { status?: string }).status ?? null });
  const { v1, v2 } = await onBothSides(async (side) => {
    const threadId = await threadWith("stateful_values_graph", "Hello");
    const loading = await side.mount({
      assistantId: "stateful_values_graph",
      threadId,
      options: { initialValues: { messages: CACHED, status: "cached-draft" } },
      extra: status,
    });
    await loading.until((s) => !s.isThreadLoading && s.messages[0]?.text === "Hello", "the thread");
    const beforeLoad = firstRender(loading);
    const loaded = shown(loading);
    await loading.unmount();

    const fresh = await side.mount({
      assistantId: "stateful_values_graph",
      options: { initialValues: { messages: CACHED, status: "cached-draft" } },
      extra: status,
    });
    const beforeRun = firstRender(fresh);
    await fresh.stream.submit(say("Fresh request"));
    await fresh.until((s) => !s.isLoading && s.messages.some((m) => m.text === "Done."), "the run");
    const afterRun = shown(fresh);
    await fresh.unmount();

    const keyed = await side.mount({
      assistantId: "stateful_values_graph",
      options: { messagesKey: "chat", initialValues: { chat: CACHED } },
    });
    return { beforeLoad, loaded, beforeRun, afterRun, keyed: keyed.stream.messages.map((m) => m.text) };
  });

  const { afterRun: v1AfterRun, loaded: v1Loaded, ...v1Rest } = v1;
  const { afterRun: v2AfterRun, loaded: v2Loaded, ...v2Rest } = v2;
  expect(v2Rest).toEqual(v1Rest);
  const cachedAfter = (...own: string[]) => [...own, "Cached user message", "Cached AI response"];
  expect(v1Loaded, v1Bug("initialMessagesStay")).toEqual({ texts: cachedAfter("Hello", "Done."), status: "final" });
  expect(v1AfterRun, v1Bug("initialMessagesStay")).toEqual({ texts: cachedAfter("Fresh request", "Done."), status: "final" });
  expect(v2Loaded).toEqual({ texts: ["Hello", "Done."], status: "final" });
  expect(v2AfterRun).toEqual({ texts: ["Fresh request", "Done."], status: "final" });
  expect(v2.beforeLoad).toEqual({ texts: ["Cached user message", "Cached AI response"], status: "cached-draft" });
  expect(v2.keyed).toEqual(["Cached user message", "Cached AI response"]);
});

itOnJsServer("StreamProvider gives its children one stream, and useStreamContext outside it throws", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { StreamProvider, useStreamContext } = side.hooks;
    const seen: Record<string, Probe["stream"]> = {};
    function Child({ name }: { name: string }) {
      seen[name] = useStreamContext() as Probe["stream"];
      return null;
    }
    await render(
      <StreamProvider assistantId="stategraph_text" apiUrl={apiUrl}>
        <Child name="a" />
        <Child name="b" />
      </StreamProvider>
    );
    await seen.a.submit(say("Hello"));
    await vi.waitFor(
      () => {
        if (seen.b.isLoading || seen.b.messages.length !== 2) throw new Error("waiting for the run in b");
      },
      { timeout: 30_000 }
    );

    function Orphan() {
      useStreamContext();
      return null;
    }
    const consoleError = console.error;
    console.error = () => undefined;
    const orphan = await render(<Orphan />).then(
      () => "rendered",
      (error: Error) => error.message
    );
    console.error = consoleError;
    return {
      oneStream: seen.a === seen.b,
      b: seen.b.messages.map((m) => m.text),
      namesProvider: /StreamProvider/.test(orphan),
    };
  });

  expect(v2).toEqual(v1);
  expect(v2).toEqual({ oneStream: true, b: ["Hello", "Plan accepted."], namesProvider: true });
});

class Boundary extends Component<{ onError: (error: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

itOnJsServer("useSuspenseStream suspends until the thread loads, a failed load reaches the error boundary, and the selector hooks take it", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const { useSuspenseStream, useMessages } = side.hooks;
    const seen: {
      stream?: Probe["stream"] & { isStreaming: boolean };
      fallback: number;
      boundary: string[];
      selector?: string[] | string;
    } = { fallback: 0, boundary: [] };
    function Fallback() {
      seen.fallback += 1;
      return null;
    }
    function Selectors({ stream }: { stream: Probe["stream"] }) {
      seen.selector = useMessages(stream).map((m) => m.text);
      return null;
    }
    function Chat(options: Record<string, unknown>) {
      const stream = useSuspenseStream({ apiUrl, ...options } as never) as typeof seen.stream;
      seen.stream = stream;
      return (
        <Boundary onError={(error) => (seen.selector = `threw: ${error.message}`)}>
          <Selectors stream={stream!} />
        </Boundary>
      );
    }
    const mount = (options: Record<string, unknown>) =>
      render(
        <Boundary onError={(error) => seen.boundary.push(error.message)}>
          <Suspense fallback={<Fallback />}>
            <Chat {...options} />
          </Suspense>
        </Boundary>
      );
    const waitFor = (check: () => boolean, what: string) =>
      vi.waitFor(
        () => {
          if (!check()) throw new Error(`${side.name}: waiting for ${what}`);
        },
        { timeout: 30_000 }
      );

    const threadId = await threadWith("stategraph_text", "Hello");
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      const opened = await mount({ assistantId: "stategraph_text", threadId });
      await waitFor(() => seen.stream?.messages.length === 2, "the thread");
      const suspended = seen.fallback > 0;
      await seen.stream!.submit(say("Again"));
      await waitFor(() => seen.stream?.messages.length === 4 && !seen.stream.isStreaming, "the run");
      const afterRun = { texts: seen.stream!.messages.map((m) => m.text), selector: seen.selector };
      const hasRespondAll = typeof (seen.stream as { respondAll?: unknown }).respondAll === "function";
      await opened.unmount();

      seen.boundary = [];
      const failedRun = await mount({ assistantId: "error_graph" });
      await seen.stream!.submit(say("Hello")).catch(() => undefined);
      await waitFor(() => seen.boundary.length > 0 || (seen.stream?.error != null && !seen.stream.isStreaming), "the failed run");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runErrorReachedBoundary = seen.boundary.length > 0;
      await failedRun.unmount();

      seen.boundary = [];
      await mount({ assistantId: "stategraph_text", threadId: crypto.randomUUID(), apiUrl: "http://localhost:1/nope", callerOptions: { maxRetries: 0 } });
      await waitFor(() => seen.boundary.length > 0, "the failed load to reach the boundary");
      return { suspended, afterRun, hasRespondAll, runErrorReachedBoundary };
    } finally {
      console.error = consoleError;
    }
  });

  expect(v2.suspended).toBe(true);
  expect(v1.suspended).toBe(true);
  expect(v2.afterRun.texts).toEqual(["Hello", "Plan accepted.", "Again", "Plan accepted."]);
  expect(v1.afterRun.texts).toEqual(v2.afterRun.texts);
  expect(v2.afterRun.selector).toEqual(v2.afterRun.texts);
  expect(v1.afterRun.selector).toEqual(v2.afterRun.selector);
  expect(v2.hasRespondAll).toBe(true);
  expect(v1.hasRespondAll, "1.x's useSuspenseStream has no respondAll").toBe(false);
  expect(v1.runErrorReachedBoundary, is("suspenseThrowsLoadOnly")).toBe(true);
  expect(v2.runErrorReachedBoundary, is("suspenseThrowsLoadOnly")).toBe(false);
});
