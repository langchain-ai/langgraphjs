import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../../src/server.mjs";

export type ProtocolEnvelope = Record<string, any>;

export const TEST_PORT = 2245;
export const TEST_API_URL = `http://127.0.0.1:${TEST_PORT}`;

const TEST_GRAPHS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "graphs"
);

export const globalConfig = {
  configurable: {
    user_id: "protocol-v2-user",
  },
};

export const startProtocolV2Server = async () =>
  startServer({
    port: TEST_PORT,
    nWorkers: 2,
    host: "127.0.0.1",
    cwd: TEST_GRAPHS_DIR,
    graphs: {
      stategraph_text: "./stategraph_text.mts:graph",
      create_agent: "./create_agent.mts:graph",
      deep_agent: "./deep_agent.mts:graph",
    },
    http: {
      disable_assistants: false,
      disable_threads: false,
      disable_runs: false,
      disable_store: false,
      disable_meta: false,
    },
  });

export const openSseSession = async (
  target: { kind: "graph" | "agent"; id: string }
) => {
  const openResponse = await fetch(`${TEST_API_URL}/v2/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "session.open",
      params: {
        protocolVersion: "0.3.0",
        target,
      },
    }),
  }).then((response) => response.json());

  const sessionId = openResponse.result.sessionId as string;
  const eventsResponse = await fetch(
    `${TEST_API_URL}/v2/sessions/${sessionId}/events`,
    {
      headers: { Accept: "text/event-stream" },
    }
  );

  if (!eventsResponse.ok) {
    throw new Error(`Failed to open SSE stream for session ${sessionId}`);
  }

  return { openResponse, sessionId, eventsResponse };
};

export const sendSessionCommand = async (
  sessionId: string,
  command: ProtocolEnvelope
) =>
  fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }).then((response) => response.json());

export const subscribeToChannels = async (
  sessionId: string,
  channels: string[],
  id: number = 1
) =>
  sendSessionCommand(sessionId, {
    id,
    method: "subscription.subscribe",
    params: { channels },
  });

export const runSession = async (
  sessionId: string,
  input: unknown,
  threadId: string,
  id: number = 2
) =>
  sendSessionCommand(sessionId, {
    id,
    method: "run.input",
    params: {
      input,
      config: {
        configurable: {
          ...globalConfig.configurable,
          thread_id: threadId,
        },
      },
    },
  });

export const readSseEventsUntilIdle = async (
  response: Response,
  idleMs: number = 500,
  timeoutMs: number = 15_000
) => {
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected SSE response body");

  let buffer = "";
  const events: Array<{ event?: string; data?: unknown; id?: string }> = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("__idle__")), idleMs)
      ),
    ]).catch((error) => {
      if (error instanceof Error && error.message === "__idle__") {
        return "__idle__" as const;
      }
      throw error;
    });

    if (chunk === "__idle__") break;
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex < 0) break;

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsed: { event?: string; data?: unknown; id?: string } = {};
      const dataLines: string[] = [];

      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
        if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }

      if (dataLines.length > 0) {
        parsed.data = JSON.parse(dataLines.join("\n"));
      }

      if (parsed.event != null || parsed.data != null) {
        events.push(parsed);
      }
    }
  }

  reader.releaseLock();
  return events;
};

const normalizeScalar = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value
      )
    ) {
      return "<uuid>";
    }
    if (value.startsWith("019") && value.length > 20) {
      return "<id>";
    }
  }
  if (typeof value === "number") return value;
  return value;
};

export const normalizeForSnapshot = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForSnapshot(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (key === "timestamp") return [key, "<timestamp>"];
        if (key === "seq") return [key, "<seq>"];
        if (key === "eventId") return [key, "<event-id>"];
        if (key === "sessionId") return [key, "<session-id>"];
        if (key === "subscriptionId") return [key, "<subscription-id>"];
        if (key === "runId") return [key, "<run-id>"];
        if (key === "threadId") return [key, "<thread-id>"];
        return [key, normalizeForSnapshot(entry)];
      })
    );
  }

  return normalizeScalar(value);
};

export const collectProtocolTranscript = async (options: {
  target: { kind: "graph" | "agent"; id: string };
  channels: string[];
  input: unknown;
  threadId: string;
}) => {
  const { openResponse, sessionId, eventsResponse } = await openSseSession(
    options.target
  );

  const subscribeResponse = await subscribeToChannels(
    sessionId,
    options.channels,
    1
  );
  const runResponse = await runSession(
    sessionId,
    options.input,
    options.threadId,
    2
  );
  const treeResponse = await sendSessionCommand(sessionId, {
    id: 3,
    method: "agent.getTree",
    params: {},
  });
  const stateResponse = await sendSessionCommand(sessionId, {
    id: 4,
    method: "state.get",
    params: {},
  });

  const events = await readSseEventsUntilIdle(eventsResponse);

  return normalizeForSnapshot({
    openResponse,
    subscribeResponse,
    runResponse,
    treeResponse,
    stateResponse,
    events: events.map((event) => ({
      event: event.event,
      id: event.id != null ? "<event-id>" : undefined,
      data: normalizeForSnapshot(event.data),
    })),
  });
};
