import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../../src/server.mjs";

export type ProtocolEnvelope = Record<string, any>;
export type ProtocolTarget = { kind: "graph" | "agent"; id: string };

export const TEST_PORT = 2245;
export const TEST_API_URL = `http://127.0.0.1:${TEST_PORT}`;
export const TEST_WS_URL = `ws://127.0.0.1:${TEST_PORT}`;

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
      interrupt_graph: "./interrupt_graph.mts:graph",
    },
    http: {
      disable_assistants: false,
      disable_threads: false,
      disable_runs: false,
      disable_store: false,
      disable_meta: false,
    },
  });

export const resetProtocolV2ServerState = async () => {
  const response = await fetch(`${TEST_API_URL}/internal/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runs: true,
      threads: true,
      assistants: false,
      checkpointer: true,
      store: true,
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to reset protocol-v2 test server state");
  }
};

class BufferedSocket {
  private readonly queue: ProtocolEnvelope[] = [];

  private readonly waiters: Array<{
    predicate: (payload: ProtocolEnvelope) => boolean;
    resolve: (payload: ProtocolEnvelope) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let payload: ProtocolEnvelope;
      try {
        payload = JSON.parse(String(event.data)) as ProtocolEnvelope;
      } catch {
        return;
      }

      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(payload)
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(payload);
        return;
      }

      this.queue.push(payload);
    });
  }

  async next(
    predicate: (payload: ProtocolEnvelope) => boolean,
    timeoutMs: number = 10_000
  ): Promise<ProtocolEnvelope> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      return this.queue.splice(queuedIndex, 1)[0];
    }

    return new Promise<ProtocolEnvelope>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for websocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

export const openSseSession = async (target: ProtocolTarget) => {
  const openResponse = await fetch(`${TEST_API_URL}/v2/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "session.open",
      params: {
        protocol_version: "0.3.0",
        target,
      },
    }),
  }).then((response) => response.json());

  const sessionId = openResponse.result.session_id as string;
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

export const openWebSocketSession = async (target: ProtocolTarget) => {
  const socket = new WebSocket(`${TEST_WS_URL}/v2/runs`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Failed to open websocket")),
      { once: true }
    );
  });

  const reader = new BufferedSocket(socket);
  socket.send(
    JSON.stringify({
      id: 0,
      method: "session.open",
      params: {
        protocol_version: "0.3.0",
        target,
      },
    })
  );

  const openResponse = await reader.next(
    (payload) => payload.type === "success" && payload.id === 0
  );

  return { openResponse, socket, reader };
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

export const readWebSocketEventsUntilIdle = async (
  reader: BufferedSocket,
  idleMs: number = 500
) => {
  const events: ProtocolEnvelope[] = [];

  while (true) {
    try {
      const payload = await reader.next(
        (message) => message.type === "event",
        idleMs
      );
      events.push(payload);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Timed out waiting for websocket message"
      ) {
        break;
      }
      throw error;
    }
  }

  return events;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForSseSessionToSettle = async (
  sessionId: string,
  eventsResponse: Response,
  startingCommandId: number
) => {
  let commandId = startingCommandId;
  let treeResponse: ProtocolEnvelope | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    treeResponse = await sendSessionCommand(sessionId, {
      id: commandId++,
      method: "agent.getTree",
      params: {},
    });
    if (treeResponse?.result?.tree?.status !== "running") break;
    await sleep(100);
  }

  await sleep(300);
  const events = await readSseEventsUntilIdle(eventsResponse, 1_000);
  const stateResponse = await sendSessionCommand(sessionId, {
    id: commandId++,
    method: "state.get",
    params: {},
  });

  return { treeResponse, stateResponse, events, nextCommandId: commandId };
};

const waitForWebSocketSessionToSettle = async (
  socket: WebSocket,
  reader: BufferedSocket,
  startingCommandId: number
) => {
  let commandId = startingCommandId;
  let treeResponse: ProtocolEnvelope | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    socket.send(
      JSON.stringify({
        id: commandId,
        method: "agent.getTree",
        params: {},
      })
    );
    treeResponse = await reader.next(
      (payload) => payload.type === "success" && payload.id === commandId
    );
    commandId += 1;

    if (treeResponse?.result?.tree?.status !== "running") break;
    await sleep(100);
  }

  await sleep(300);
  const events = await readWebSocketEventsUntilIdle(reader, 1_000);

  socket.send(
    JSON.stringify({
      id: commandId,
      method: "state.get",
      params: {},
    })
  );
  const stateResponse = await reader.next(
    (payload) => payload.type === "success" && payload.id === commandId
  );

  return { treeResponse, stateResponse, events, nextCommandId: commandId + 1 };
};

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GENERATED_ID_PATTERN = /019[a-z0-9-]{20,}/gi;

const normalizeEmbeddedIds = (value: string) =>
  value.replace(GENERATED_ID_PATTERN, "<id>").replace(UUID_PATTERN, "<uuid>");

const normalizeScalar = (value: unknown): unknown => {
  if (typeof value === "string") {
    const normalized = normalizeEmbeddedIds(value);
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
    return normalized;
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
        if (key === "event_id") return [key, "<event-id>"];
        if (key === "session_id") return [key, "<session-id>"];
        if (key === "subscription_id") return [key, "<subscription-id>"];
        if (key === "run_id") return [key, "<run-id>"];
        if (key === "thread_id") return [key, "<thread-id>"];
        return [key, normalizeForSnapshot(entry)];
      })
    );
  }

  return normalizeScalar(value);
};

const normalizeTransportString = (value: string) => normalizeEmbeddedIds(value);

const normalizeSnapshotCommandResponse = (value: ProtocolEnvelope | undefined) => {
  if (value == null || typeof value !== "object") {
    return value;
  }

  return {
    ...value,
    ...(typeof value.id === "number" ? { id: "<command-id>" } : {}),
  };
};

export const normalizeForTransportParity = (value: unknown): unknown => {
  if (typeof value === "string") {
    return normalizeTransportString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForTransportParity(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (key === "timestamp") return [key, "<timestamp>"];
        if (key === "seq") return [key, "<seq>"];
        if (key === "event_id") return [key, "<event-id>"];
        if (key === "session_id") return [key, "<session-id>"];
        if (key === "subscription_id") return [key, "<subscription-id>"];
        if (key === "run_id") return [key, "<run-id>"];
        if (key === "thread_id") return [key, "<thread-id>"];
        return [key, normalizeForTransportParity(entry)];
      })
    );
  }

  return value;
};

export const collectProtocolTranscript = async (options: {
  target: ProtocolTarget;
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
  const { treeResponse, stateResponse, events } = await waitForSseSessionToSettle(
    sessionId,
    eventsResponse,
    3
  );

  return normalizeForSnapshot({
    openResponse,
    subscribeResponse,
    runResponse,
    treeResponse: normalizeSnapshotCommandResponse(treeResponse),
    stateResponse: normalizeSnapshotCommandResponse(stateResponse),
    events: events.map((event) => ({
      event: event.event,
      id: event.id != null ? "<event-id>" : undefined,
      data: normalizeForSnapshot(event.data),
    })),
  });
};

export const collectSseParityTranscript = async (options: {
  target: ProtocolTarget;
  channels: string[];
  input: unknown;
  threadId: string;
}) => {
  const { sessionId, eventsResponse } = await openSseSession(options.target);
  let commandId = 1;

  await subscribeToChannels(sessionId, options.channels, commandId++);
  await runSession(sessionId, options.input, options.threadId, commandId++);
  const { treeResponse, stateResponse, events } = await waitForSseSessionToSettle(
    sessionId,
    eventsResponse,
    commandId
  );

  return normalizeForTransportParity({
    tree: treeResponse?.result?.tree,
    values: stateResponse.result?.values,
    events: events
      .map((event) => event.data)
      .filter((event): event is Record<string, unknown> => event != null),
  });
};

export const collectWebSocketParityTranscript = async (options: {
  target: ProtocolTarget;
  channels: string[];
  input: unknown;
  threadId: string;
}) => {
  const { socket, reader } = await openWebSocketSession(options.target);

  try {
    let commandId = 1;

    socket.send(
      JSON.stringify({
        id: commandId,
        method: "subscription.subscribe",
        params: { channels: options.channels },
      })
    );
    await reader.next(
      (payload) => payload.type === "success" && payload.id === commandId
    );
    commandId += 1;

    socket.send(
      JSON.stringify({
        id: commandId,
        method: "run.input",
        params: {
          input: options.input,
          config: {
            configurable: {
              ...globalConfig.configurable,
              thread_id: options.threadId,
            },
          },
        },
      })
    );
    await reader.next(
      (payload) => payload.type === "success" && payload.id === commandId
    );
    commandId += 1;

    const { treeResponse, stateResponse, events } =
      await waitForWebSocketSessionToSettle(
        socket,
        reader,
        commandId
      );

    return normalizeForTransportParity({
      tree: treeResponse?.result?.tree,
      values: stateResponse.result?.values,
      events: events.filter(
        (event): event is Record<string, unknown> => event != null
      ),
    });
  } finally {
    reader.close();
  }
};
