import { expect, it } from "vitest";

import { is } from "./differences.js";
import { expectSameSummary, jsGraphs, onBothSides, runsOf, summary } from "./harness.js";

interface ChannelEvent {
  method: string;
  params: { namespace: string[]; data: any };
}

const say = (content: string) => ({ messages: [{ type: "human", content }] });
const ended = (count: number) => (runs: { status: string }[]) =>
  runs.length === count && runs.every((run) => run.status !== "pending" && run.status !== "running");
const dataOf = (events: unknown[]) => (events as ChannelEvent[]).map((event) => event.params.data);

/** What `custom_channel_graph` writes on each run. */
const WRITES = [{ stage: "thinking" }, { name: "status", payload: { label: "answering" } }, { stage: "done" }];

function streamedText(events: ChannelEvent[]) {
  return events
    .filter((event) => event.method === "messages")
    .map(({ params: { data } }) =>
      Array.isArray(data)
        ? typeof data[0]?.content === "string"
          ? data[0].content
          : ""
        : data?.event === "content-block-delta"
          ? (data.delta?.text ?? "")
          : ""
    )
    .join("");
}

it("custom events reach useChannel and useChannelEffect on every run, bufferSize keeps the newest, and enabled: false gets none", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const delivered: unknown[] = [];
    const disabled: unknown[] = [];
    const probe = await side.mount({
      assistantId: "custom_channel_graph",
      extra: (stream, hooks) => {
        hooks.useChannelEffect(stream, ["custom"], { onEvent: (event) => delivered.push(event) });
        hooks.useChannelEffect(stream, ["custom"], { onEvent: (event) => disabled.push(event), enabled: false });
        return {
          all: dataOf(hooks.useChannel(stream, ["custom"])),
          newest: dataOf(hooks.useChannel(stream, ["custom"], undefined, { bufferSize: 1 })),
        };
      },
    });
    for (const [i, content] of ["one", "two"].entries()) {
      await probe.stream.submit(say(content));
      await runsOf(probe.stream.threadId!, ended(i + 1));
    }
    await summary(probe);
    return { ...(probe.extra as { all: unknown[]; newest: unknown[] }), delivered: dataOf(delivered), disabled };
  });

  const twice = [...WRITES, ...WRITES];
  expect(v2.all, is("customWrapsEveryWrite")).toEqual(twice.map((write) => ({ payload: write })));
  expect(v1.all, is("customWrapsEveryWrite")).toEqual(
    jsGraphs ? twice.map((write) => ("name" in write ? write : { payload: write })) : v2.all
  );
  for (const side of [v1, v2]) {
    expect(side.delivered).toEqual(side.all);
    expect(side.newest).toEqual(side.all.slice(-1));
    expect(side.disabled).toEqual([]);
  }
});

it("lifecycle and messages in one useChannelEffect: the reply's chunks add up to it, and the run ends with completed", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const events: ChannelEvent[] = [];
    const probe = await side.mount({
      assistantId: "stategraph_text",
      extra: (stream, hooks) => {
        hooks.useChannelEffect(stream, ["lifecycle", "messages"], {
          onEvent: (event) => events.push(event as ChannelEvent),
        });
        return null;
      },
    });
    await probe.stream.submit(say("Hello"));
    await runsOf(probe.stream.threadId!, ended(1));
    const runEvents = (events: ChannelEvent[]) =>
      events.filter((e) => e.method === "lifecycle" && e.params.namespace.length === 0).map((e) => e.params.data.event);
    await probe.until(() => runEvents(events).at(-1) === "completed", "the run's last event");
    return { text: streamedText(events), runEvents: runEvents(events), reply: probe.stream.messages.at(-1)?.text };
  });

  for (const side of [v1, v2]) {
    expect(side.text, is("channelEvents")).toBe(side.reply);
  }
  expect(v2.text).toBe("Plan accepted.");
  expect(v1.runEvents, is("channelEvents")).toEqual(["running", "completed"]);
  expect(v2.runEvents, is("channelEvents")).toEqual(["completed"]);
});

it("a root channel hook gets the main agent's tool events, and with a Python graph 1.x's also gets its subagents'", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const events: ChannelEvent[] = [];
    const probe = await side.mount({
      assistantId: "deep_agent",
      extra: (stream, hooks) => {
        hooks.useChannelEffect(stream, ["lifecycle", "messages", "tools"], {
          onEvent: (event) => events.push(event as ChannelEvent),
        });
        return null;
      },
    });
    await probe.stream.submit(say("Research and analyze"));
    await runsOf(probe.stream.threadId!, ended(1));
    await probe.until(() => events.some((e) => e.method === "lifecycle" && e.params.data.event === "completed" && e.params.namespace.length === 0), "the run's end");
    return events
      .filter((e) => e.method === "tools" && e.params.data.event === "tool-started")
      .map((e) => e.params.data.tool_name)
      .sort();
  });

  expect(v2).toEqual(["task", "task"]);
  expect(v1, is("rootChannelsIncludeSubagents")).toEqual(jsGraphs ? v2 : ["query_database", "search_web", "task", "task"]);
});

it("the tools channel shows a tool call's start and finish with its id, and root toolCalls match", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({
      assistantId: "create_agent",
      extra: (stream, hooks) =>
        dataOf(hooks.useChannel(stream, ["tools"])).map((data) => [data.event, data.tool_call_id, data.tool_name ?? null]),
    });
    await probe.stream.submit(say("Weather in San Francisco?"));
    await runsOf(probe.stream.threadId!, ended(1));
    await probe.until((s) => !s.isLoading, "the run");
    return summary(probe);
  });

  expectSameSummary(v1, v2);
  expect(v2.final.extra).toEqual([
    ["tool-started", "call-weather-1", "get_weather"],
    ["tool-finished", "call-weather-1", null],
  ]);
  expect(v2.final.toolCalls).toEqual([expect.objectContaining({ name: "get_weather", status: "finished" })]);
});
