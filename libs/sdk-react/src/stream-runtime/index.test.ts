import { describe, expect, it, vi } from "vitest";

import { createStreamRuntime } from "./index.js";
import { LegacyStreamRuntime } from "./legacy.js";
import { ProtocolStreamRuntime } from "./protocol/runtime.js";

vi.mock("./legacy.js", () => {
  class MockLegacyStreamRuntime {
    submit = vi.fn(async () => "legacy-submit");
    join = vi.fn(async () => "legacy-join");
  }

  return { LegacyStreamRuntime: MockLegacyStreamRuntime };
});

vi.mock("./protocol/runtime.js", () => {
  class MockProtocolStreamRuntime {
    readonly canSubmit = vi.fn(() => true);
    readonly submit = vi.fn(async () => "protocol-submit");
    readonly join = vi.fn(async () => "protocol-join");

    constructor(
      public readonly client: unknown,
      public readonly streamProtocol: unknown,
      public readonly options: unknown,
    ) {}
  }

  return { ProtocolStreamRuntime: MockProtocolStreamRuntime };
});

describe("createStreamRuntime", () => {
  const client = {
    runs: {},
  } as unknown;

  it("returns the legacy runtime when streamProtocol is legacy", async () => {
    const { runtime, protocolRuntime } = createStreamRuntime(
      client as never,
      "legacy",
    );

    expect(runtime).toBeInstanceOf(LegacyStreamRuntime);
    expect(protocolRuntime).toBeInstanceOf(ProtocolStreamRuntime);
  });

  it("uses the protocol runtime for v2-sse", async () => {
    const fetchFactory = vi.fn(() => fetch);
    const { runtime, protocolRuntime } = createStreamRuntime(
      client as never,
      "v2-sse",
      fetchFactory,
    );

    expect(protocolRuntime.streamProtocol).toBe("v2-sse");
    expect(protocolRuntime.options).toEqual({
      protocolFetch: fetchFactory,
      protocolWebSocket: undefined,
    });

    const result = await runtime.submit({
      assistantId: "agent",
      threadId: "thread-1",
      input: {},
      signal: new AbortController().signal,
      streamMode: ["values"],
    });

    expect(result).toBe("protocol-submit");
  });

  it("uses the protocol runtime for v2-websocket", async () => {
    const socketFactory = vi.fn();
    const { runtime, protocolRuntime } = createStreamRuntime(
      client as never,
      "v2-websocket",
      undefined,
      socketFactory as never,
    );

    expect(protocolRuntime.streamProtocol).toBe("v2-websocket");
    expect(protocolRuntime.options).toEqual({
      protocolFetch: undefined,
      protocolWebSocket: socketFactory,
    });

    const result = await runtime.join({
      threadId: "thread-1",
      runId: "run-1",
      signal: new AbortController().signal,
    });

    expect(result).toBe("protocol-join");
  });

  it("falls back to the legacy submit runtime when protocol cannot handle the request", async () => {
    const { runtime, protocolRuntime } = createStreamRuntime(
      client as never,
      "v2-sse",
    );

    protocolRuntime.canSubmit.mockReturnValueOnce(false);

    const result = await runtime.submit({
      assistantId: "agent",
      threadId: "thread-1",
      input: {},
      signal: new AbortController().signal,
      streamMode: ["events"],
    });

    expect(result).toBe("legacy-submit");
  });
});
