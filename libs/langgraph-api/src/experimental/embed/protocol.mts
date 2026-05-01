import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import type { UpgradeWebSocket } from "hono/ws";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod/v3";

import * as schemas from "../../schemas.mjs";
import type { Run } from "../../storage/types.mjs";
import { streamState } from "../../stream.mjs";
import { serialiseAsDict } from "../../utils/serde.mjs";
import { jsonExtra } from "../../utils/hono.mjs";
import { RunProtocolSession } from "../../protocol/session/index.mjs";
import { PROTOCOL_STREAM_RUN_KEY } from "../../protocol/constants.mjs";
import { matchesSinkFilter } from "../../protocol/service.mjs";
import type {
  EventSinkFilter,
  ProtocolCommand,
  ProtocolEvent,
  SourceStreamEvent,
} from "../../protocol/types.mjs";

import type { EmbedRouteContext, EmbedThread } from "./types.mjs";
import {
  ProtocolCommandSchema,
  ThreadIdSchema,
  isRecord,
  createStubRun,
} from "./utils.mjs";
import { DEFAULT_PROTOCOL_STREAM_MODES } from "./constants.mjs";

const EventsFilterSchema = z
  .object({
    channels: z.array(z.string()),
    namespaces: z.array(z.array(z.string())).optional(),
    depth: z.number().int().nonnegative().optional(),
    since: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Normalize browser/node websocket payloads into UTF-8 text so the
 * protocol layer only needs to handle JSON strings.
 */
const parseSocketPayload = async (event: MessageEvent): Promise<string> => {
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
 * Register thread-centric v2 protocol routes on an embed server Hono app.
 *
 * @experimental Does not follow semver.
 */
export function registerProtocolRoutes(
  api: Hono,
  context: EmbedRouteContext,
  upgradeWebSocket?: UpgradeWebSocket
) {
  const threads = new Map<string, EmbedThread>();

  function ensureThread(threadId: string): EmbedThread {
    let thread = threads.get(threadId);
    if (thread == null) {
      thread = {
        threadId,
        seq: 0,
        eventSinks: new Map(),
        queuedEvents: [],
      };
      threads.set(threadId, thread);
    }
    return thread;
  }

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

  function attachRunSession(thread: EmbedThread, run: Run) {
    const rawSource = streamState(run, {
      attempt: 1,
      getGraph: context.getGraph,
      signal: undefined,
    });
    const source = trackRunStatus(rawSource, run);

    const protocolSession = new RunProtocolSession({
      runId: run.run_id,
      threadId: thread.threadId,
      initialRun: run,
      getRun: async () => thread.currentRun ?? null,
      getThreadState: async () => {
        const persisted = await context.threads.get(thread.threadId);
        const graphId = persisted?.metadata?.graph_id as string | undefined;
        if (!graphId) return null;
        const graph = await context.getGraph(graphId);
        const snapshot = await graph.getState(
          { configurable: { thread_id: thread.threadId } },
          { subgraphs: true }
        );
        return {
          tasks: snapshot.tasks.map((t: { interrupts?: unknown[] }) => ({
            interrupts: t.interrupts,
          })),
        };
      },
      source,
      startSeq: thread.seq,
      passthrough: true,
      send: async (payload) => {
        const parsed = JSON.parse(payload) as ProtocolEvent;
        thread.seq = Math.max(thread.seq, parsed.seq ?? thread.seq);
        // Always buffer events so late-attaching sinks can replay
        // matching history. Sinks with `pendingReplay` are skipped
        // here; their replay loop delivers this event in buffer order.
        thread.queuedEvents.push(parsed);
        for (const sink of thread.eventSinks.values()) {
          if (sink.pendingReplay) continue;
          if (sink.unfiltered || matchesSinkFilter(sink.filter, parsed)) {
            await sink.send(parsed);
          }
        }
      },
    });

    thread.runSession = protocolSession;
    thread.currentRun = run;
    return protocolSession;
  }

  async function handleRunStart(thread: EmbedThread, command: ProtocolCommand) {
    const params: Record<string, unknown> = isRecord(command.params)
      ? command.params
      : {};
    const assistantId =
      typeof params.assistant_id === "string" ? params.assistant_id : undefined;

    if (!assistantId) {
      return jsonResponse({
        type: "error",
        id: command.id,
        error: "invalid_argument",
        message: "run.start requires an assistant_id.",
      });
    }
    if (thread.assistantId != null && thread.assistantId !== assistantId) {
      return jsonResponse({
        type: "error",
        id: command.id,
        error: "invalid_argument",
        message: `Thread ${thread.threadId} is bound to assistant ${thread.assistantId}; cannot run ${assistantId}.`,
      });
    }
    thread.assistantId = assistantId;

    const runMetadata = isRecord(params.metadata)
      ? (params.metadata as Record<string, unknown>)
      : {};

    // Lazily create the persisted thread on first use.
    let persisted: Awaited<ReturnType<typeof context.threads.get>> | null =
      null;
    try {
      persisted = await context.threads.get(thread.threadId);
    } catch {
      persisted = null;
    }
    if (persisted == null) {
      await context.threads.set(thread.threadId, {
        kind: "put",
        metadata: {
          ...runMetadata,
          graph_id: assistantId,
          assistant_id: assistantId,
        },
      });
    } else {
      await context.threads.set(thread.threadId, {
        kind: "patch",
        metadata: {
          ...runMetadata,
          graph_id: assistantId,
          assistant_id: assistantId,
        },
      });
    }

    // Promote SDK-side `forkFrom: { checkpointId }` into
    // `configurable.checkpoint_id` so the engine replays from the
    // requested fork target. This mirrors the promotion performed by
    // `ProtocolService.createOrResumeRun` in the non-embed path and
    // closes the "client sends forkFrom, server drops it" gap.
    const forkCheckpointId = (() => {
      if (!isRecord(params.forkFrom)) return undefined;
      const id = params.forkFrom.checkpointId;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    })();

    const run = createStubRun(thread.threadId, {
      assistant_id: assistantId,
      on_disconnect: "cancel",
      input: params.input ?? null,
      config: {
        configurable: {
          ...(isRecord(params.config) && isRecord(params.config.configurable)
            ? params.config.configurable
            : {}),
        },
      },
      // `createStubRun` promotes the top-level `checkpoint_id` into
      // `config.configurable.checkpoint_id` after merging (and, in
      // fact, *replaces* any inline configurable the caller passed),
      // so this is the only reliable way to reach the engine with a
      // fork target.
      ...(forkCheckpointId != null ? { checkpoint_id: forkCheckpointId } : {}),
      metadata: Object.keys(runMetadata).length > 0 ? runMetadata : undefined,
      stream_mode: DEFAULT_PROTOCOL_STREAM_MODES,
      stream_subgraphs: true,
    } as unknown as z.infer<typeof schemas.RunCreate>);
    run.kwargs[PROTOCOL_STREAM_RUN_KEY] = true;

    const protocolSession = attachRunSession(thread, run);
    await protocolSession.start();

    return jsonResponse({
      type: "success",
      id: command.id,
      result: { run_id: run.run_id },
      meta: {
        thread_id: thread.threadId,
        applied_through_seq: thread.seq,
      },
    });
  }

  async function handleInputRespond(
    thread: EmbedThread,
    command: ProtocolCommand
  ) {
    const params: Record<string, unknown> = isRecord(command.params)
      ? command.params
      : {};
    const interruptId = params.interrupt_id;

    if (typeof interruptId !== "string") {
      return jsonResponse({
        type: "error",
        id: command.id,
        error: "invalid_argument",
        message: "input.respond requires an interrupt_id.",
      });
    }

    const assistantId = thread.assistantId;
    if (assistantId == null) {
      return jsonResponse({
        type: "error",
        id: command.id,
        error: "no_such_run",
        message: "Thread has no active assistant; call run.start first.",
      });
    }

    const run = createStubRun(thread.threadId, {
      assistant_id: assistantId,
      on_disconnect: "cancel",
      input: null,
      command: { resume: { [interruptId]: params.response } },
      stream_mode: DEFAULT_PROTOCOL_STREAM_MODES,
      stream_subgraphs: true,
    } as unknown as z.infer<typeof schemas.RunCreate>);
    run.kwargs[PROTOCOL_STREAM_RUN_KEY] = true;

    // Drop the previous run's buffered events so that a sink attaching
    // *after* this resume does not replay stale terminal lifecycle
    // events (e.g. `lifecycle.interrupted`) from the paused run. Any
    // sink that was already receiving live events is unaffected.
    thread.queuedEvents.length = 0;

    const protocolSession = attachRunSession(thread, run);
    await protocolSession.start();

    return jsonResponse({
      type: "success",
      id: command.id,
      result: {},
      meta: {
        thread_id: thread.threadId,
        applied_through_seq: thread.seq,
      },
    });
  }

  async function handleThreadCommand(
    thread: EmbedThread,
    command: ProtocolCommand
  ) {
    if (command.method === "run.start") {
      return await handleRunStart(thread, command);
    }
    if (command.method === "input.respond") {
      return await handleInputRespond(thread, command);
    }
    // WebSocket transports send `subscription.subscribe`/`unsubscribe`
    // over the same socket before any run is bound. The embed server
    // delivers *all* events to the WS sink and relies on the SDK to
    // filter client-side, so we can accept these commands without
    // additional bookkeeping.
    if (command.method === "subscription.subscribe") {
      const subscriptionId = uuidv7();
      return jsonResponse({
        type: "success",
        id: command.id,
        result: { subscription_id: subscriptionId },
        meta: {
          thread_id: thread.threadId,
          applied_through_seq: thread.seq,
        },
      });
    }
    if (command.method === "subscription.unsubscribe") {
      return jsonResponse({
        type: "success",
        id: command.id,
        result: {},
        meta: {
          thread_id: thread.threadId,
          applied_through_seq: thread.seq,
        },
      });
    }
    if (thread.runSession == null) {
      return jsonResponse({
        type: "error",
        id: command.id,
        error: "no_such_run",
        message: "No active run is bound to this thread.",
      });
    }
    return jsonResponse(
      await thread.runSession.handleProtocolCommand(command, {
        thread_id: thread.threadId,
        applied_through_seq: thread.seq,
      })
    );
  }

  function jsonResponse(body: unknown) {
    return new Response(serialiseAsDict(body), {
      headers: { "Content-Type": "application/json" },
    });
  }

  api.post(
    "/v2/threads/:thread_id/commands",
    zValidator("param", ThreadIdSchema),
    zValidator("json", ProtocolCommandSchema),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const thread = ensureThread(thread_id);
      const command = c.req.valid("json") as unknown as ProtocolCommand;
      return await handleThreadCommand(thread, command);
    }
  );

  api.post(
    "/v2/threads/:thread_id/stream",
    zValidator("param", ThreadIdSchema),
    zValidator("json", EventsFilterSchema),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const thread = ensureThread(thread_id);

      const body = c.req.valid("json");
      const sinkId = uuidv7();
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

        // Register the sink as replaying so the live `send` path skips
        // it while we drain buffered events in order. A cursor-based
        // drain catches any events pushed during our awaits, then we
        // unblock live delivery.
        const sink = {
          id: sinkId,
          filter,
          send: writeSse,
          pendingReplay: true,
        };
        thread.eventSinks.set(sinkId, sink);
        try {
          let cursor = 0;
          while (cursor < thread.queuedEvents.length) {
            const event = thread.queuedEvents[cursor++];
            if (matchesSinkFilter(filter, event)) {
              await writeSse(event);
            }
          }
        } finally {
          sink.pendingReplay = false;
        }

        stream.onAbort(() => {
          thread.eventSinks.delete(sinkId);
        });

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      });
    }
  );

  if (upgradeWebSocket != null) {
    api.get(
      "/v2/threads/:thread_id/stream",
      zValidator("param", ThreadIdSchema),
      upgradeWebSocket((c: any) => {
        const { thread_id } = c.req.valid("param");
        const thread = ensureThread(thread_id);
        const sinkId = uuidv7();

        return {
          async onOpen(_event: Event, ws: { send: (source: string) => void }) {
            // Unfiltered sink: forward every buffered + live event to the
            // websocket in order, so the browser ThreadStream sees the
            // complete event history regardless of subscription timing.
            const writeWs = async (event: ProtocolEvent) => {
              ws.send(serialiseAsDict(event));
            };
            const sink = {
              id: sinkId,
              filter: {
                channels: new Set<string>(),
                namespaces: undefined,
                depth: undefined,
                since: undefined,
              } as EventSinkFilter,
              send: writeWs,
              pendingReplay: true,
              unfiltered: true,
            };
            thread.eventSinks.set(sinkId, sink);
            try {
              let cursor = 0;
              while (cursor < thread.queuedEvents.length) {
                await writeWs(thread.queuedEvents[cursor++]);
              }
            } finally {
              sink.pendingReplay = false;
            }
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

            const response = await handleThreadCommand(
              thread,
              payload as ProtocolCommand
            );
            const body = await response.text();
            ws.send(body);
          },
          onClose() {
            thread.eventSinks.delete(sinkId);
          },
          onError() {
            thread.eventSinks.delete(sinkId);
          },
        } as any;
      })
    );
  }

  // jsonExtra is no longer needed but keep import indirection minimal.
  void jsonExtra;
}
