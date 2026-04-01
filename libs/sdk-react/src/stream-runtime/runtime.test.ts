import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn();
const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn(async () => undefined);
const inputMock = vi.fn();
const closeMock = vi.fn(async () => undefined);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@langchain/client", () => {
  class MockProtocolClient {
    readonly open = openMock;

    constructor(_transportFactory: unknown) {}
  }

  return {
    ProtocolClient: MockProtocolClient,
    ProtocolSseTransportAdapter: vi.fn(),
    ProtocolWebSocketTransportAdapter: vi.fn(),
  };
});

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

  it("binds the resolved thread to session.open and run.input", async () => {
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
      submitOptions: {
        config: {
          configurable: {
            user_id: "user-1",
          },
        },
      },
      signal: new AbortController().signal,
      streamMode: ["messages-tuple", "tools", "values"],
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: "0.3.0",
        config: {
          configurable: {
            user_id: "user-1",
            thread_id: "thread-1",
          },
        },
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

    expect(inputMock).toHaveBeenCalledWith({
      input: { messages: [] },
      config: {
        configurable: {
          user_id: "user-1",
          thread_id: "thread-1",
        },
      },
      metadata: undefined,
    });
  });

  it("waits for the terminal lifecycle event before closing the session", async () => {
    const eventResult = createDeferred<IteratorResult<unknown>>();
    subscribeMock.mockResolvedValue({
      unsubscribe: unsubscribeMock,
      [Symbol.asyncIterator]: () => ({
        next: async () => await eventResult.promise,
      }),
    });

    const runtime = new ProtocolStreamRuntime(
      {
        runs: {
          apiUrl: "http://localhost:2024",
        },
      } as never,
      "v2-sse",
    );

    const stream = await runtime.submit({
      assistantId: "agent",
      threadId: "thread-1",
      input: { messages: [] },
      submitOptions: {},
      signal: new AbortController().signal,
      streamMode: ["messages-tuple", "tools", "values"],
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        event: "metadata",
        data: {
          run_id: "run-1",
          thread_id: "thread-1",
        },
      },
    });

    const completion = stream.next();
    await Promise.resolve();

    expect(unsubscribeMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();

    eventResult.resolve({
      done: false,
      value: {
        type: "event",
        eventId: "evt-1",
        method: "lifecycle",
        params: {
          namespace: [],
          timestamp: Date.now(),
          data: {
            event: "completed",
          },
        },
      },
    });

    await expect(completion).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
