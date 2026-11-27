import { createElement, StrictMode } from "react";
import { cleanup, render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import {
  StreamDevtoolsSession,
  type StreamDevtoolsRecord,
} from "@langchain/langgraph-sdk/stream";
import { useStream, type UseStreamReturn } from "../use-stream.js";

it("seeks the mounted hook in StrictMode without executing headless tools or commands", async () => {
  const records: StreamDevtoolsRecord[] = [];
  const session = new StreamDevtoolsSession({
    onRecord: (record) => records.push(record),
  });
  const execute = vi.fn(async () => "result");
  const onTool = vi.fn();
  const onCompleted = vi.fn();
  const network = vi.fn();
  const client = { threads: { stream: network, getState: network } };
  let stream: UseStreamReturn<{ label: string }> | undefined;
  function Probe() {
    stream = useStream<{ label: string }>({
      assistantId: "test",
      client: client as never,
      devtools: session,
      initialValues: { label: "live" },
      tools: [{ tool: { name: "lookup" }, execute }],
      onTool,
      onCompleted,
    });
    return createElement(
      "span",
      { "data-testid": "label" },
      stream.values.label
    );
  }
  const screen = await render(
    createElement(StrictMode, null, createElement(Probe))
  );
  try {
    const staleSubmit = stream!.submit;
    expect(screen.getByTestId("label").element().textContent).toBe("live");
    const baseline = records.find((record) => record.type === "baseline")!;
    session.reset();
    session.apply(baseline);
    session.apply({
      version: 1,
      type: "event",
      source: "root",
      event: {
        type: "event",
        event_id: "values",
        seq: 1,
        method: "values",
        params: {
          namespace: [],
          timestamp: 1,
          data: {
            label: "replayed",
            __interrupt__: [
              {
                id: "tool",
                value: { type: "tool", toolCall: { name: "lookup", args: {} } },
              },
            ],
          },
        },
      },
    });
    session.flush();
    await expect
      .poll(() => screen.getByTestId("label").element().textContent)
      .toBe("replayed");
    await expect(stream!.submit({ label: "blocked" })).rejects.toThrow(
      "disabled during devtools replay"
    );
    await expect(staleSubmit({ label: "blocked" })).rejects.toThrow(
      "disabled during devtools replay"
    );
    expect(execute).not.toHaveBeenCalled();
    expect(onTool).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    session.reset();
    session.apply(baseline);
    session.flush();
    await expect
      .poll(() => screen.getByTestId("label").element().textContent)
      .toBe("live");
    session.live();
    await expect.poll(() => stream!.values.label).toBe("live");
    expect(records).toHaveLength(1);
  } finally {
    await cleanup();
  }
});
