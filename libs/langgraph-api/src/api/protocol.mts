import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { UpgradeWebSocket } from "hono/ws";
import { v7 as uuid7 } from "uuid";
import { z } from "zod/v3";

import { ProtocolService } from "../protocol/service.mjs";
import type { EventSinkFilter, ProtocolCommand } from "../protocol/types.mjs";
import type { Ops } from "../storage/types.mjs";
import { jsonExtra } from "../utils/hono.mjs";
import { serialiseAsDict } from "../utils/serde.mjs";

const ThreadIdSchema = z.object({ thread_id: z.string() });

const EventsFilterSchema = z
  .object({
    channels: z.array(z.string()),
    namespaces: z.array(z.array(z.string())).optional(),
    depth: z.number().int().nonnegative().optional(),
    since: z.number().int().nonnegative().optional(),
  })
  .strict();

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
 * Register thread-centric protocol transport routes for LangGraph API.
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
    "/threads/:thread_id/stream/events",
    zValidator("param", ThreadIdSchema),
    upgradeWebSocket((c: any) => {
      const { thread_id } = c.req.valid("param");
      const record = protocolService.ensureThread({
        threadId: thread_id,
        transport: "websocket" as const,
        auth: c.var.auth,
      });

      return {
        async onOpen(_event: Event, ws: { send: (source: string) => void }) {
          await protocolService.attachEventSink(thread_id, (event) => {
            ws.send(serialiseAsDict(event));
          });
        },
        async onMessage(
          event: MessageEvent,
          ws: { send: (source: string) => void }
        ) {
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
            record.threadId,
            payload as ProtocolCommand
          );
          // `null` means the session already wrote the response through
          // the shared transport queue (see
          // `ProtocolSession.handleSubscribeForResponse`). Sending again
          // here would double-deliver the success and break ordering.
          if (response != null) {
            ws.send(serialiseAsDict(response));
          }
        },
        onClose() {
          void protocolService.closeThread(record.threadId);
        },
        onError() {
          void protocolService.closeThread(record.threadId);
        },
      } as any;
    })
  );

  api.post(
    "/threads/:thread_id/commands",
    zValidator("param", ThreadIdSchema),
    zValidator("json", ProtocolCommandSchema),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      protocolService.ensureThread({
        threadId: thread_id,
        transport: "sse-http" as const,
        auth: c.var.auth,
      });
      const payload = c.req.valid("json") as unknown as ProtocolCommand;
      return jsonExtra(
        c,
        await protocolService.handleCommand(thread_id, payload)
      );
    }
  );

  api.post(
    "/threads/:thread_id/stream/events",
    zValidator("param", ThreadIdSchema),
    zValidator("json", EventsFilterSchema),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      protocolService.ensureThread({
        threadId: thread_id,
        transport: "sse-http" as const,
        auth: c.var.auth,
      });

      const body = c.req.valid("json");
      const sinkId = uuid7();
      const filter: EventSinkFilter = {
        channels: new Set(body.channels),
        namespaces: body.namespaces,
        depth: body.depth,
        since: body.since,
      };

      return streamSSE(c, async (stream) => {
        const delivered = new Set<string>();

        const writeSse = async (event: {
          event_id?: string | null;
          method: string;
          [k: string]: unknown;
        }) => {
          if (event.event_id == null) return;
          if (delivered.has(event.event_id)) return;
          delivered.add(event.event_id);
          await stream.writeSSE({
            id: event.event_id,
            event: event.method,
            data: serialiseAsDict(event),
          });
        };

        await protocolService.attachFilteredEventSink(thread_id, {
          id: sinkId,
          filter,
          send: writeSse,
        });

        stream.onAbort(() => {
          protocolService.detachEventSink(thread_id, sinkId);
        });

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      });
    }
  );

  return api;
}
