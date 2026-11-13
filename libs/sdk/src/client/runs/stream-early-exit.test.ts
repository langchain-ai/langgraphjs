import { describe, test, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "../../client.js";

/**
 * These tests use a real local HTTP server (not a mocked `fetch`) because the
 * behaviour under test is whether the underlying connection is closed when a
 * consumer stops iterating.
 */
interface SSEServer {
  url: string;
  /** Number of SSE events written so far. */
  writes: () => number;
  /** Resolves once the server observes the response connection closing. */
  closed: Promise<void>;
  close: () => Promise<void>;
}

async function startSSEServer(options: {
  /** Total events to write before ending the response. `Infinity` = never. */
  total: number;
  intervalMs?: number;
}): Promise<SSEServer> {
  let writes = 0;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-location": "/threads/t1/runs/r1",
    });
    const timer = setInterval(() => {
      writes += 1;
      res.write(`id: ${writes}\nevent: values\ndata: {"n":${writes}}\n\n`);
      if (writes >= options.total) {
        clearInterval(timer);
        res.end();
      }
    }, options.intervalMs ?? 10);
    res.on("close", () => {
      clearInterval(timer);
      markClosed();
    });
    // Drain the request body so the response is not held back by it.
    req.resume();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    writes: () => writes,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Rejects if `promise` does not settle within `ms`. */
function within<T>(promise: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not happen within ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

describe("SSE streams close the connection when the consumer stops early", () => {
  let server: SSEServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("runs.stream: break closes the HTTP connection", async () => {
    server = await startSSEServer({ total: Infinity });
    const client = new Client({ apiUrl: server.url });

    let seen = 0;
    for await (const _chunk of client.runs.stream("t1", "agent", {
      input: {},
      streamMode: "values",
    })) {
      seen += 1;
      if (seen === 2) break;
    }

    await within(server.closed, 2_000, "server-side connection close");
    expect(seen).toBe(2);
    // The server stopped writing shortly after the consumer left.
    expect(server.writes()).toBeLessThan(50);
  });

  test("runs.joinStream: break closes the HTTP connection", async () => {
    server = await startSSEServer({ total: Infinity });
    const client = new Client({ apiUrl: server.url });

    let seen = 0;
    for await (const _chunk of client.runs.joinStream("t1", "r1")) {
      seen += 1;
      if (seen === 2) break;
    }

    await within(server.closed, 2_000, "server-side connection close");
    expect(seen).toBe(2);
  });

  test("runs.stream: an error thrown by the consumer closes the connection", async () => {
    server = await startSSEServer({ total: Infinity });
    const client = new Client({ apiUrl: server.url });

    await expect(async () => {
      for await (const _chunk of client.runs.stream("t1", "agent", {
        input: {},
        streamMode: "values",
      })) {
        throw new Error("consumer failed");
      }
    }).rejects.toThrow("consumer failed");

    await within(server.closed, 2_000, "server-side connection close");
  });

  test("runs.stream: consuming the whole stream still completes normally", async () => {
    server = await startSSEServer({ total: 5 });
    const client = new Client({ apiUrl: server.url });

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const chunk of client.runs.stream("t1", "agent", {
      input: {},
      streamMode: "values",
    })) {
      events.push(chunk);
    }

    expect(events.map((e) => e.data)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ]);
    await within(server.closed, 2_000, "server-side connection close");
    expect(server.writes()).toBe(5);
  });
});
