import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn();
const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn(async () => undefined);
const inputMock = vi.fn();
const closeMock = vi.fn(async () => undefined);

vi.mock("@langchain/client", () => {
  class MockProtocolClient {
    readonly open = openMock;

    constructor(_transportFactory: unknown) {}
  }

  return { ProtocolClient: MockProtocolClient };
});

vi.mock("./http-transport.js", () => ({
  ProtocolSseTransportAdapter: vi.fn(),
}));

vi.mock("./websocket-transport.js", () => ({
  ProtocolWebSocketTransportAdapter: vi.fn(),
}));

import { ProtocolStreamRuntime } from "./runtime.js";

describe("ProtocolStreamRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    subscribeMock.mockResolvedValue({
      unsubscribe: unsubscribeMock,
      async *[Symbol.asyncIterator]() {},
    });

    inputMock.mockResolvedValue({ runId: "run-1" });
    openMock.mockResolvedValue({
      subscribe: subscribeMock,
      run: { input: inputMock },
      close: closeMock,
    });
  });

  it("advertises subscribed protocol channels during session open", async () => {
    const runtime = new ProtocolStreamRuntime(
      {
        runs: {
          apiUrl: "http://localhost:2024",
        },
      } as never,
      "v2-sse",
    );

    await runtime.submit({
      assistantId: "agent",
      threadId: "thread-1",
      input: { messages: [] },
      signal: new AbortController().signal,
      streamMode: ["messages-tuple", "tools", "values"],
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: "0.3.0",
        capabilities: {
          modules: expect.arrayContaining([
            expect.objectContaining({
              name: "subscription",
              commands: ["subscribe", "unsubscribe", "reconnect"],
            }),
            expect.objectContaining({
              name: "run",
              commands: ["input"],
            }),
            expect.objectContaining({
              name: "agent",
              channels: ["lifecycle"],
            }),
            expect.objectContaining({
              name: "messages",
              channels: ["messages"],
            }),
            expect.objectContaining({
              name: "tools",
              channels: ["tools"],
            }),
            expect.objectContaining({
              name: "values",
              channels: ["values"],
            }),
          ]),
        },
      }),
    );

    expect(subscribeMock).toHaveBeenCalledWith({
      channels: ["lifecycle", "messages", "tools", "values"],
    });
  });
});
