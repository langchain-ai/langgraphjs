import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod/v3";

import * as schemas from "../../schemas.mjs";
import type { Run } from "../../storage/types.mjs";
import { streamState } from "../../stream.mjs";
import { serialiseAsDict } from "../../utils/serde.mjs";
import { jsonExtra } from "../../utils/hono.mjs";
import { RunProtocolSession } from "../../protocol/session/index.mjs";
import { PROTOCOL_MESSAGES_STREAM_CONFIG_KEY } from "../../protocol/constants.mjs";
import type {
  ProtocolCommand,
  ProtocolEvent,
  ProtocolTarget,
  SourceStreamEvent,
} from "../../protocol/types.mjs";

import type { EmbedRouteContext, EmbedSession } from "./types.mjs";
import {
  ProtocolSessionOpenSchema,
  ProtocolCommandSchema,
  SessionIdSchema,
  isRecord,
  createStubRun,
} from "./utils.mjs";
import {
  PROTOCOL_VERSION,
  DEFAULT_PROTOCOL_STREAM_MODES,
} from "./constants.mjs";

/**
 * Register v2 protocol session routes on an embed server Hono app.
 *
 * @experimental Does not follow semver.
 */
export function registerProtocolRoutes(api: Hono, context: EmbedRouteContext) {
  const sessions = new Map<string, EmbedSession>();

  async function* trackRunStatus(
    source: AsyncGenerator<SourceStreamEvent>,
    run: Run
  ): AsyncGenerator<SourceStreamEvent> {
    try {
      yield* source;
      (run as Run & { status: string }).status = "success";
    } catch (error) {
      (run as Run & { status: string }).status = "error";
      throw error;
    }
  }

  function attachRunSession(session: EmbedSession, run: Run, threadId: string) {
    const rawSource = streamState(run, {
      attempt: 1,
      getGraph: context.getGraph,
      signal: undefined,
    });
    const source = trackRunStatus(rawSource, run);

    const protocolSession = new RunProtocolSession({
      runId: run.run_id,
      threadId,
      initialRun: run,
      getRun: async () => session.currentRun ?? null,
      getThreadState: async () => {
        const thread = await context.threads.get(threadId);
        const graphId = thread?.metadata?.graph_id as string | undefined;
        if (!graphId) return null;
        const graph = await context.getGraph(graphId);
        const snapshot = await graph.getState(
          { configurable: { thread_id: threadId } },
          { subgraphs: true }
        );
        return {
          tasks: snapshot.tasks.map((t: { interrupts?: unknown[] }) => ({
            interrupts: t.interrupts,
          })),
        };
      },
      source,
      send: async (payload) => {
        const parsed = JSON.parse(payload) as ProtocolEvent;
        session.seq = Math.max(session.seq, parsed.seq ?? session.seq);
        if (session.sendEvent != null) {
          await session.sendEvent(parsed);
        } else {
          session.queuedEvents.push(parsed);
        }
      },
    });

    session.runSession = protocolSession;
    session.currentRun = run;
    session.currentThreadId = threadId;
    return protocolSession;
  }

  async function handleRunInput(
    session: EmbedSession,
    command: ProtocolCommand
  ) {
    const params = isRecord(command.params) ? command.params : {};
    const targetId = session.target.id;
    const threadId = uuidv7();

    await context.threads.set(threadId, {
      kind: "put",
      metadata: { graph_id: targetId, assistant_id: targetId },
    });

    const run = createStubRun(threadId, {
      assistant_id: targetId,
      on_disconnect: "cancel",
      input: params.input ?? null,
      config: {
        configurable: {
          ...(isRecord(params.config) && isRecord(params.config.configurable)
            ? params.config.configurable
            : {}),
          [PROTOCOL_MESSAGES_STREAM_CONFIG_KEY]: true,
        },
      },
      metadata: isRecord(params.metadata)
        ? (params.metadata as Record<string, unknown>)
        : undefined,
      stream_mode: DEFAULT_PROTOCOL_STREAM_MODES,
      stream_subgraphs: true,
    } as unknown as z.infer<typeof schemas.RunCreate>);

    const protocolSession = attachRunSession(session, run, threadId);
    await protocolSession.start();

    for (const pending of session.pendingCommands.splice(0)) {
      await protocolSession.handleProtocolCommand(pending, {
        session_id: session.sessionId,
        applied_through_seq: session.seq,
      });
    }

    return jsonResponse({
      type: "success",
      id: command.id,
      result: { run_id: run.run_id },
      meta: {
        session_id: session.sessionId,
        applied_through_seq: session.seq,
      },
    });
  }

  async function handleSessionCommand(
    session: EmbedSession,
    command: ProtocolCommand
  ) {
    if (command.method === "session.describe") {
      return jsonResponse({
        type: "success",
        id: command.id,
        result: {
          session_id: session.sessionId,
          protocol_version: PROTOCOL_VERSION,
          transport: {
            name: "sse-http",
            event_ordering: "seq",
            command_delivery: "request-response",
            media_transfer_modes: ["artifact-only", "upgrade-to-websocket"],
          },
          capabilities: {
            modules: [],
            payload_types: [],
            content_block_types: [],
          },
        },
        meta: {
          session_id: session.sessionId,
          applied_through_seq: session.seq,
        },
      });
    }

    if (command.method === "session.close") {
      await session.runSession?.close();
      sessions.delete(session.sessionId);
      return jsonResponse({
        type: "success",
        id: command.id,
        result: {},
        meta: {
          session_id: session.sessionId,
          applied_through_seq: session.seq,
        },
      });
    }

    if (command.method === "run.input") {
      return await handleRunInput(session, command);
    }

    if (session.runSession == null) {
      session.pendingCommands.push(command);
      const result: Record<string, unknown> = {};
      if (command.method === "subscription.subscribe") {
        result.subscription_id = uuidv7();
        result.replayed_events = 0;
      }
      return jsonResponse({
        type: "success",
        id: command.id,
        result,
        meta: {
          session_id: session.sessionId,
          applied_through_seq: session.seq,
        },
      });
    }

    return jsonResponse(
      await session.runSession.handleProtocolCommand(command, {
        session_id: session.sessionId,
        applied_through_seq: session.seq,
      })
    );
  }

  function jsonResponse(body: unknown) {
    return new Response(serialiseAsDict(body), {
      headers: { "Content-Type": "application/json" },
    });
  }

  api.post(
    "/v2/sessions",
    zValidator("json", ProtocolSessionOpenSchema),
    async (c) => {
      const payload = c.req.valid("json");
      const sessionId = uuidv7();
      const target: ProtocolTarget = { id: payload.params.target.id };

      const session: EmbedSession = {
        sessionId,
        target,
        seq: 0,
        queuedEvents: [],
        pendingCommands: [],
      };
      sessions.set(sessionId, session);

      return jsonExtra(c, {
        type: "success",
        id: 0,
        result: {
          session_id: sessionId,
          protocol_version: PROTOCOL_VERSION,
          transport: {
            name: "sse-http",
            event_ordering: "seq",
            command_delivery: "request-response",
            media_transfer_modes: ["artifact-only", "upgrade-to-websocket"],
          },
          capabilities: {
            modules: [],
            payload_types: [],
            content_block_types: [],
          },
          eventsUrl: `/v2/sessions/${sessionId}/events`,
          commandsUrl: `/v2/sessions/${sessionId}/commands`,
        },
        meta: {
          session_id: sessionId,
          applied_through_seq: 0,
        },
      });
    }
  );

  api.post(
    "/v2/sessions/:session_id/commands",
    zValidator("param", SessionIdSchema),
    zValidator("json", ProtocolCommandSchema),
    async (c) => {
      const { session_id } = c.req.valid("param");
      const session = sessions.get(session_id);
      if (session == null) return c.json({ error: "Session not found" }, 404);

      const command = c.req.valid("json") as unknown as ProtocolCommand;
      return await handleSessionCommand(session, command);
    }
  );

  api.get(
    "/v2/sessions/:session_id/events",
    zValidator("param", SessionIdSchema),
    async (c) => {
      const { session_id } = c.req.valid("param");
      const session = sessions.get(session_id);
      if (session == null) return c.body("Session not found", 404);

      const lastEventId = c.req.header("Last-Event-ID") || undefined;

      return streamSSE(c, async (stream) => {
        const delivered = new Set<string>();
        const queued = session.queuedEvents.filter((event) => {
          if (
            lastEventId != null &&
            event.event_id != null &&
            event.event_id <= lastEventId
          ) {
            return false;
          }
          return true;
        });
        for (const event of queued) {
          if (event.event_id == null) continue;
          delivered.add(event.event_id);
          await stream.writeSSE({
            id: event.event_id,
            event: event.method,
            data: serialiseAsDict(event),
          });
        }

        session.sendEvent = async (event) => {
          if (event.event_id == null) return;
          if (delivered.has(event.event_id)) return;
          delivered.add(event.event_id);
          await stream.writeSSE({
            id: event.event_id,
            event: event.method,
            data: serialiseAsDict(event),
          });
        };

        for (const event of session.queuedEvents.splice(0)) {
          if (event.event_id == null) continue;
          if (delivered.has(event.event_id)) continue;
          delivered.add(event.event_id);
          await stream.writeSSE({
            id: event.event_id,
            event: event.method,
            data: serialiseAsDict(event),
          });
        }

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      });
    }
  );

  api.delete(
    "/v2/sessions/:session_id",
    zValidator("param", SessionIdSchema),
    async (c) => {
      const { session_id } = c.req.valid("param");
      const session = sessions.get(session_id);
      if (session != null) {
        await session.runSession?.close();
        sessions.delete(session_id);
      }
      return c.body(null, 204);
    }
  );
}
