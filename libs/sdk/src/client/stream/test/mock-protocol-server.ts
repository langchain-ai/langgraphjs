/**
 * Minimal in-process mock of the v2 LangGraph protocol surface used by
 * {@link ProtocolSseTransportAdapter} and {@link ProtocolWebSocketTransportAdapter}.
 *
 * Mirrors the replay semantics of `langgraph-api` embed protocol: events are
 * buffered per thread, SSE subscriptions honour `since` in the POST body, and
 * WebSocket connections replay the full buffer on each connect.
 *
 * WebSocket serving uses the `ws` package; clients use the Node.js 22+ global
 * {@link WebSocket} API.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type MockProtocolEvent = {
  type: "event";
  method: string;
  event_id: string;
  seq: number;
  params?: { namespace?: string[]; data?: unknown };
};

export interface MockProtocolServerOptions {
  threadId?: string;
  events: MockProtocolEvent[];
  /** Drop the first SSE connection after delivering this many matching events. */
  failSseAfterDelivered?: number;
  /** Close the first WebSocket after delivering this many events. */
  failWsAfterDelivered?: number;
}

export interface MockProtocolServer {
  readonly apiUrl: string;
  readonly threadId: string;
  readonly sseConnectionCount: () => number;
  readonly wsConnectionCount: () => number;
  /** Forcibly close a prior WebSocket connection (1-based index). */
  closeWebSocketConnection(connectionIndex: number): void;
  close(): Promise<void>;
}

type FlushableServerResponse = ServerResponse & {
  flush?: () => void;
};

const MIN_NODE_MAJOR = 22;

function assertNodeWebSocketGlobal(): void {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  if (major < MIN_NODE_MAJOR || typeof globalThis.WebSocket !== "function") {
    throw new Error(
      `Mock protocol server requires Node.js ${MIN_NODE_MAJOR}+ with a global WebSocket (found Node ${process.versions.node}).`
    );
  }
}

function serialise(value: unknown): string {
  return JSON.stringify(value);
}

function matchesChannels(
  event: MockProtocolEvent,
  channels: string[] | undefined
): boolean {
  if (channels == null || channels.length === 0) {
    return true;
  }
  return channels.includes(event.method);
}

function filterEvents(
  events: MockProtocolEvent[],
  channels: string[] | undefined,
  since: number | undefined
): MockProtocolEvent[] {
  return events.filter(
    (event) =>
      matchesChannels(event, channels) && (since == null || event.seq > since)
  );
}

function writeSseFrame(
  res: FlushableServerResponse,
  event: MockProtocolEvent
): void {
  const payload = serialise(event);
  res.write(`id: ${event.event_id}\n`);
  res.write(`event: ${event.method}\n`);
  res.write(`data: ${payload}\n\n`);
}

export async function startMockProtocolServer(
  options: MockProtocolServerOptions
): Promise<MockProtocolServer> {
  assertNodeWebSocketGlobal();

  const threadId = options.threadId ?? "thread_mock";
  const events = [...options.events].sort((a, b) => a.seq - b.seq);

  let sseConnections = 0;
  let wsConnections = 0;
  const wsSocketsByConnection = new Map<number, WebSocket>();

  const wss = new WebSocketServer({ noServer: true });

  const httpServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (
      req.method === "POST" &&
      url.pathname === `/threads/${threadId}/commands`
    ) {
      void handleCommand(req, res);
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === `/threads/${threadId}/stream/events`
    ) {
      void handleSse(req, res);
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== `/threads/${threadId}/stream/events`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  function buildCommandResponse(command: {
    id?: number;
    method?: string;
  }): Record<string, unknown> {
    if (command.method === "subscription.subscribe") {
      return {
        type: "success",
        id: command.id,
        result: { subscription_id: `sub_${command.id}` },
      };
    }

    if (command.method === "run.start") {
      return {
        type: "success",
        id: command.id,
        result: { run_id: "run_mock" },
        meta: { applied_through_seq: 0 },
      };
    }

    return {
      type: "success",
      id: command.id,
      result: {},
    };
  }

  wss.on("connection", (ws) => {
    wsConnections += 1;
    const connectionIndex = wsConnections;
    wsSocketsByConnection.set(connectionIndex, ws);

    ws.on("close", () => {
      wsSocketsByConnection.delete(connectionIndex);
    });

    let delivered = 0;
    let disconnectScheduled = false;

    const push = (event: MockProtocolEvent): boolean => {
      if (ws.readyState !== ws.OPEN || disconnectScheduled) {
        return false;
      }
      ws.send(serialise(event));
      delivered += 1;
      if (
        connectionIndex === 1 &&
        options.failWsAfterDelivered != null &&
        delivered >= options.failWsAfterDelivered
      ) {
        disconnectScheduled = true;
        queueMicrotask(() => ws.close(1011, "mock disconnect"));
      }
      return true;
    };

    const replayEvents = (): void => {
      for (const event of events) {
        if (!push(event)) {
          break;
        }
      }
    };

    // Subsequent sockets simulate server-side replay after reconnect.
    if (connectionIndex > 1) {
      queueMicrotask(() => replayEvents());
    }

    ws.on("message", (raw) => {
      let command: { id?: number; method?: string };
      try {
        command = JSON.parse(String(raw)) as {
          id?: number;
          method?: string;
        };
      } catch {
        return;
      }
      if (
        typeof command.id !== "number" ||
        typeof command.method !== "string"
      ) {
        return;
      }
      if (ws.readyState === ws.OPEN) {
        ws.send(serialise(buildCommandResponse(command)));
      }
      // Mirror server replay: buffered events are delivered when the
      // client subscribes, not at socket connect (avoids racing
      // `run.start` / command round-trips on the same connection).
      if (command.method === "subscription.subscribe") {
        replayEvents();
      }
    });
  });

  async function handleCommand(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let command: { id?: number; method?: string };
    try {
      command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method?: string;
      };
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(serialise(buildCommandResponse(command)));
  }

  async function handleSse(
    req: import("node:http").IncomingMessage,
    res: FlushableServerResponse
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: {
      channels?: string[];
      since?: number;
    };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        channels?: string[];
        since?: number;
      };
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    sseConnections += 1;
    const connectionIndex = sseConnections;
    const toDeliver = filterEvents(events, body.channels, body.since);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "close");

    const failAfterDelivered =
      connectionIndex === 1 ? options.failSseAfterDelivered : undefined;

    if (failAfterDelivered != null) {
      // Truncated Content-Length forces the fetch body to error once the
      // socket closes before the declared length is reached.
      res.setHeader("content-length", "65536");
    }

    res.flushHeaders?.();

    let delivered = 0;

    try {
      for (const event of toDeliver) {
        writeSseFrame(res, event);
        if (typeof res.flush === "function") {
          res.flush();
        }
        delivered += 1;

        if (failAfterDelivered != null && delivered >= failAfterDelivered) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          res.socket?.destroy(new Error("mock SSE disconnect"));
          return;
        }
      }
      res.end();
    } catch {
      res.destroy();
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.on("error", reject);
  });

  const address = httpServer.address() as AddressInfo;
  const apiUrl = `http://127.0.0.1:${address.port}`;

  return {
    apiUrl,
    threadId,
    sseConnectionCount: () => sseConnections,
    wsConnectionCount: () => wsConnections,
    closeWebSocketConnection: (connectionIndex: number) => {
      const ws = wsSocketsByConnection.get(connectionIndex);
      if (ws != null && ws.readyState === ws.OPEN) {
        ws.close(1011, "mock disconnect");
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) {
          client.close(1000, "server shutdown");
        }
        wss.close((wsErr) => {
          if (wsErr) {
            reject(wsErr);
            return;
          }
          httpServer.close((httpErr) => {
            if (httpErr) reject(httpErr);
            else resolve();
          });
        });
      }),
  };
}
