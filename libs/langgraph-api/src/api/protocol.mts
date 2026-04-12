import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v3";

import { ProtocolService } from "../protocol/service.mjs";
import type { ProtocolCommand, ProtocolTarget } from "../protocol/types.mjs";
import type { Ops } from "../storage/types.mjs";
import { jsonExtra } from "../utils/hono.mjs";
import { serialiseAsDict } from "../utils/serde.mjs";

const SessionIdSchema = z.object({ session_id: z.string() });

const ProtocolSessionOpenSchema = z.object({
  method: z.literal("session.open"),
  params: z.object({
    protocol_version: z.string(),
    target: z.object({
      id: z.string(),
    }),
    preferred_transports: z.array(z.string()).optional(),
    media_transfer_modes: z.array(z.string()).optional(),
  }),
});

const ProtocolCommandSchema = z.object({
  id: z.number().int().nonnegative(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

/**
 * Normalize browser/node websocket message payloads into UTF-8 text so the
 * protocol layer only needs to handle JSON strings.
 */
const parseSocketPayload = async (event: MessageEvent) => {
  if (typeof event.data === "string") return event.data;
  if (event.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(event.data));
  }
  if (event.data instanceof Blob) {
    const buffer = await event.data.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(buffer));
  }
  return String(event.data);
};

/**
 * Convert the validated session-open payload into the internal target shape
 * used by the shared protocol service.
 */
const toSessionTarget = (
  payload: z.infer<typeof ProtocolSessionOpenSchema>
): ProtocolTarget => ({
  id: payload.params.target.id,
});

/**
 * Build websocket handlers for the compatibility run-scoped protocol routes.
 *
 * These routes now reuse the shared session service internally but retain the
 * older URL shape so existing additive consumers keep working.
 */
const createRunScopedWebSocketHandlers = (
  protocolService: ProtocolService,
  target: ProtocolTarget,
  auth: any
) => {
  let sessionId: string | undefined;
  return {
    async onOpen(_event: Event, ws: { send: (source: string) => void }) {
      const { record, response } = await protocolService.openSession({
        transportName: "websocket" as const,
        auth,
        target,
        sendEvent: (event) => {
          ws.send(serialiseAsDict(event));
        },
      });
      sessionId = record.sessionId;
      ws.send(serialiseAsDict(response));
    },
    async onMessage(
      event: MessageEvent,
      ws: { send: (source: string) => void }
    ) {
      if (sessionId == null) {
        ws.send(
          serialiseAsDict({
            type: "error",
            id: null,
            error: "invalid_argument",
            message: "Protocol session not initialized.",
          })
        );
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await parseSocketPayload(event));
      } catch {
        ws.send(
          serialiseAsDict({
            type: "error",
            id: null,
            error: "invalid_argument",
            message: "Protocol commands must be valid JSON.",
          })
        );
        return;
      }

      if (
        typeof payload !== "object" ||
        payload == null ||
        typeof (payload as { id?: unknown }).id !== "number" ||
        typeof (payload as { method?: unknown }).method !== "string"
      ) {
        ws.send(
          serialiseAsDict({
            type: "error",
            id: null,
            error: "invalid_argument",
            message:
              "Protocol commands must include an integer id and string method.",
          })
        );
        return;
      }

      const response = await protocolService.handleCommand(
        sessionId,
        payload as ProtocolCommand
      );
      ws.send(serialiseAsDict(response));
    },
    onClose() {
      if (sessionId != null) void protocolService.closeSession(sessionId);
    },
    onError() {
      if (sessionId != null) void protocolService.closeSession(sessionId);
    },
  };
};

/**
 * Register protocol transport routes for LangGraph API.
 *
 * This mounts both the new session-based `v2` transport surface and the
 * run-scoped compatibility websocket routes on top of the same shared protocol
 * service.
 */
export default function createProtocolApi(
  upgradeWebSocket: UpgradeWebSocket,
  ops: Ops
) {
  const api = new Hono();
  const protocolService = new ProtocolService({
    runs: ops.runs,
    threads: ops.threads,
  });

  api.get(
    "/v2/runs",
    upgradeWebSocket((c: any) => {
      let sessionId: string | undefined;

      return {
        async onOpen(_event: Event, _ws: { send: (source: string) => void }) {},
        async onMessage(
          event: MessageEvent,
          ws: { send: (source: string) => void }
        ) {
          const raw = await parseSocketPayload(event);
          let payload: unknown;
          try {
            payload = JSON.parse(raw);
          } catch {
            ws.send(
              serialiseAsDict({
                type: "error",
                id: null,
                error: "invalid_argument",
                message: "Protocol commands must be valid JSON.",
              })
            );
            return;
          }

          if (
            sessionId == null &&
            typeof payload === "object" &&
            payload != null &&
            (payload as { method?: unknown }).method === "session.open"
          ) {
            const parsed = ProtocolSessionOpenSchema.parse(payload);
            const { record, response } = await protocolService.openSession({
              transportName: "websocket" as const,
              auth: c.var.auth,
              target: toSessionTarget(parsed),
              sendEvent: (protocolEvent) => {
                ws.send(serialiseAsDict(protocolEvent));
              },
            });
            sessionId = record.sessionId;
            ws.send(serialiseAsDict(response));
            return;
          }

          if (sessionId == null) {
            ws.send(
              serialiseAsDict({
                type: "error",
                id:
                  typeof payload === "object" &&
                  payload != null &&
                  typeof (payload as { id?: unknown }).id === "number"
                    ? (payload as { id: number }).id
                    : null,
                error: "invalid_argument",
                message:
                  "session.open must be the first command on a protocol socket.",
              })
            );
            return;
          }

          if (
            typeof payload !== "object" ||
            payload == null ||
            typeof (payload as { id?: unknown }).id !== "number" ||
            typeof (payload as { method?: unknown }).method !== "string"
          ) {
            ws.send(
              serialiseAsDict({
                type: "error",
                id: null,
                error: "invalid_argument",
                message:
                  "Protocol commands must include an integer id and string method.",
              })
            );
            return;
          }

          const response = await protocolService.handleCommand(
            sessionId,
            payload as unknown as ProtocolCommand
          );
          ws.send(serialiseAsDict(response));
        },
        onClose() {
          if (sessionId != null) void protocolService.closeSession(sessionId);
        },
        onError() {
          if (sessionId != null) void protocolService.closeSession(sessionId);
        },
      } as any;
    })
  );

  api.post(
    "/v2/sessions",
    zValidator("json", ProtocolSessionOpenSchema),
    async (c) => {
      const payload = c.req.valid("json");
      const { record, response } = await protocolService.openSession({
        transportName: "sse-http" as const,
        auth: c.var.auth,
        target: toSessionTarget(payload),
      });

      return jsonExtra(c, {
        ...response,
        result: {
          ...response.result,
          eventsUrl: `/v2/sessions/${record.sessionId}/events`,
          commandsUrl: `/v2/sessions/${record.sessionId}/commands`,
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
      const payload = c.req.valid("json") as unknown as ProtocolCommand;
      return jsonExtra(
        c,
        await protocolService.handleCommand(session_id, payload)
      );
    }
  );

  api.get(
    "/v2/sessions/:session_id/events",
    zValidator("param", SessionIdSchema),
    async (c) => {
      const { session_id } = c.req.valid("param");
      const session = protocolService.getSession(session_id);
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

        await protocolService.attachEventSink(session_id, async (event) => {
          if (event.event_id == null) return;
          if (delivered.has(event.event_id)) return;
          delivered.add(event.event_id);
          await stream.writeSSE({
            id: event.event_id,
            event: event.method,
            data: serialiseAsDict(event),
          });
        });

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
      await protocolService.closeSession(session_id);
      return c.body(null, 204);
    }
  );

  api.get(
    "/threads/:thread_id/runs/:run_id/protocol",
    zValidator(
      "param",
      z.object({
        thread_id: z.string().uuid(),
        run_id: z.string().uuid(),
      })
    ),
    upgradeWebSocket((c: any) => {
      const { thread_id, run_id } = c.req.valid("param");
      return createRunScopedWebSocketHandlers(
        protocolService,
        { kind: "run", id: run_id, threadId: thread_id },
        c.var.auth
      ) as any;
    })
  );

  api.get(
    "/runs/:run_id/protocol",
    zValidator("param", z.object({ run_id: z.string().uuid() })),
    upgradeWebSocket((c: any) => {
      const { run_id } = c.req.valid("param");
      return createRunScopedWebSocketHandlers(
        protocolService,
        { kind: "run", id: run_id },
        c.var.auth
      ) as any;
    })
  );

  return api;
}
