import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RemoteGraph } from "../pregel/remote.js";

let server: ChildProcess | undefined;
let apiUrl: string;
const serverLogs: string[] = [];

const serverScript = fileURLToPath(
  new URL("../../../langgraph-api/tests/utils.server.mts", import.meta.url)
);
const serverConfig = fileURLToPath(
  new URL("../../../langgraph-api/tests/graphs/langgraph.json", import.meta.url)
);
const apiDir = dirname(dirname(serverScript));

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, () => {
      const address = listener.address();
      listener.close(() => {
        if (address != null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Unable to allocate a local test port."));
        }
      });
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/ok`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(
    `Timed out waiting for local LangGraph server: ${lastError}\n${serverLogs.join("").slice(-4000)}`
  );
}

async function truncateServer(url: string): Promise<void> {
  await fetch(`${url}/internal/truncate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runs: true,
      threads: true,
      assistants: true,
      store: true,
      checkpoint: true,
    }),
  });
}

beforeAll(async () => {
  const port = await getAvailablePort();
  apiUrl = `http://localhost:${port}`;
  server = spawn("tsx", [serverScript, "--dev", "-c", serverConfig], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      LANGCHAIN_TRACING_V2: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  server.stdout?.on("data", (data) => {
    serverLogs.push(data.toString());
  });
  server.stderr?.on("data", (data) => {
    serverLogs.push(data.toString());
  });

  await waitForServer(apiUrl);
  await truncateServer(apiUrl);
}, 60_000);

afterAll(() => {
  server?.kill("SIGTERM");
});

describe("RemoteGraph local server integration", () => {
  test("streams v3 events from a local graph through RemoteGraph", async () => {
    const remoteGraph = new RemoteGraph({
      graphId: "simple_runtime",
      url: apiUrl,
    });

    const run = await remoteGraph.streamEvents(
      { message: "hello from remote" },
      {
        version: "v3",
        configurable: { thread_id: randomUUID() },
      }
    );

    const events = [];
    for await (const event of run) {
      events.push(event);
      if (event.method === "values") break;
    }

    const output = await run.output;
    await run.thread.close();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "event",
          method: "values",
          params: expect.objectContaining({
            namespace: [],
            data: expect.objectContaining({
              message: "hello from remote",
            }),
          }),
        }),
      ])
    );
    expect(output).toMatchObject({
      message: "hello from remote",
      model: "unknown",
    });
  });

  test("supports text/event-stream encoding over the remote v3 path", async () => {
    const remoteGraph = new RemoteGraph({
      graphId: "simple_runtime",
      url: apiUrl,
    });

    const stream = await remoteGraph.streamEvents(
      { message: "encoded remote" },
      {
        version: "v3",
        encoding: "text/event-stream",
        configurable: { thread_id: randomUUID() },
      }
    );

    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      text += decoder.decode(chunk);
    }

    expect(text).toContain("event: values");
    expect(text).toContain("encoded remote");
  });
});
