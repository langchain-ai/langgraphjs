import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProtocolWebSocketTransportAdapter,
  webSocketReconnectDelayMs,
} from "./websocket.js";
import {
  PROXIED_API_URL,
  THREAD_ID,
  createWebSocketUrlRecorder,
} from "./test-helpers.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", new Event("open"));
    });
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (options && typeof options === "object" && options.once) {
      const wrapper: EventListener = (event) => {
        this.removeEventListener(type, wrapper);
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      };
      this.listenersFor(type).add(wrapper);
      return;
    }
    this.listenersFor(type).add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    this.listenersFor(type).delete(listener);
  }

  send(_data: string): void {
    // no-op for tests
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", new Event("close"));
  }

  simulateUnexpectedClose(): void {
    this.close();
  }

  simulateMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) } as MessageEvent);
  }

  private listenersFor(type: string): Set<EventListenerOrEventListenerObject> {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    return set;
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of [...this.listenersFor(type)]) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

describe("ProtocolWebSocketTransportAdapter URL resolution", () => {
  it("preserves apiUrl path prefix when opening the stream socket", async () => {
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      webSocketFactory,
    });

    await expect(transport.open()).rejects.toBe(sentinel);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `ws://localhost:4100/api/chat-langchain/threads/${THREAD_ID}/stream/events`
    );
  });

  it("preserves custom stream paths under a proxied apiUrl", async () => {
    const customStreamPath = `/threads/${THREAD_ID}/stream/events`;
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      paths: { stream: customStreamPath },
      webSocketFactory,
    });

    await expect(transport.open()).rejects.toBe(sentinel);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `ws://localhost:4100/api/chat-langchain${customStreamPath}`
    );
  });
});

describe("ProtocolWebSocketTransportAdapter thread binding", () => {
  it("rejects rebinding to another thread while the socket is open", async () => {
    const urls: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "thread-a",
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    await transport.open();

    expect(() => transport.setThreadId("thread-a")).not.toThrow();
    expect(() => transport.setThreadId("thread-b")).toThrow(
      /cannot be rebound/
    );
    expect(transport.threadId).toBe("thread-a");

    await transport.open();

    expect(urls).toEqual([
      "ws://localhost:8123/threads/thread-a/stream/events",
    ]);
    expect(sockets[0].readyState).toBe(FakeWebSocket.OPEN);

    await transport.close();
  });
});

describe("webSocketReconnectDelayMs", () => {
  it("caps exponential backoff", () => {
    expect(webSocketReconnectDelayMs(1)).toBeLessThanOrEqual(6000);
    expect(webSocketReconnectDelayMs(10)).toBeLessThanOrEqual(6000);
  });
});

describe("ProtocolWebSocketTransportAdapter reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("onReconnected can send commands without deadlocking on reconnectInFlight", async () => {
    let connections = 0;
    let resubscribed = false;

    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "thread-1",
      maxReconnectAttempts: 3,
      reconnectDelayMs: () => 0,
      webSocketFactory: (url) => {
        connections += 1;
        const socket = new FakeWebSocket(url);
        socket.send = (data: string) => {
          const command = JSON.parse(data) as { id: number; method: string };
          queueMicrotask(() => {
            socket.simulateMessage({
              type: "success",
              id: command.id,
              result: { subscription_id: `sub_${command.id}` },
            });
          });
        };
        if (connections === 1) {
          queueMicrotask(() => socket.simulateUnexpectedClose());
        }
        return socket as unknown as WebSocket;
      },
      onReconnected: async () => {
        await transport.send({
          id: 42,
          method: "subscription.subscribe",
          params: { channels: ["values"] },
        });
        resubscribed = true;
      },
    });

    await transport.open();
    await vi.runAllTimersAsync();

    expect(connections).toBe(2);
    expect(resubscribed).toBe(true);
    await transport.close();
  });

  it("reconnects after an unexpected close and keeps the events iterator alive", async () => {
    let connections = 0;
    const reconnected = vi.fn();

    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "thread-1",
      maxReconnectAttempts: 3,
      onReconnected: reconnected,
      webSocketFactory: (url) => {
        connections += 1;
        const socket = new FakeWebSocket(url);
        if (connections === 1) {
          queueMicrotask(() => {
            socket.simulateMessage({
              type: "event",
              method: "values",
              event_id: "evt_1",
              seq: 1,
            });
            socket.simulateUnexpectedClose();
          });
        } else {
          queueMicrotask(() => {
            socket.simulateMessage({
              type: "event",
              method: "values",
              event_id: "evt_2",
              seq: 2,
            });
          });
        }
        return socket as unknown as WebSocket;
      },
    });

    await transport.open();
    await Promise.resolve();
    const iterator = transport.events()[Symbol.asyncIterator]();

    const firstPromise = iterator.next();
    await vi.runAllTimersAsync();
    expect(connections).toBe(2);
    expect(reconnected).toHaveBeenCalledTimes(1);

    const first = await firstPromise;
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "event", event_id: "evt_1" });

    const second = await iterator.next();
    expect(second.value).toMatchObject({ type: "event", event_id: "evt_2" });

    await transport.close();
  });

  it("closes the event queue when reconnection is disabled", async () => {
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "thread-1",
      maxReconnectAttempts: 0,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        queueMicrotask(() => socket.simulateUnexpectedClose());
        return socket as unknown as WebSocket;
      },
    });

    await transport.open();
    await Promise.resolve();

    await expect(
      transport.events()[Symbol.asyncIterator]().next()
    ).rejects.toThrow(/closed unexpectedly/);

    await transport.close();
  });

  it("does not reconnect after an intentional close", async () => {
    let connections = 0;
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "thread-1",
      webSocketFactory: (url) => {
        connections += 1;
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
    });

    await transport.open();
    await transport.close();

    expect(connections).toBe(1);

    await vi.runAllTimersAsync();
    expect(connections).toBe(1);
  });
});
