import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod/v3";

import type { Run } from "../../storage/types.mjs";
import * as schemas from "../../schemas.mjs";
import { streamState } from "../../stream.mjs";
import { serialiseAsDict, serializeError } from "../../utils/serde.mjs";
import { getDisconnectAbortSignal, jsonExtra } from "../../utils/hono.mjs";

import type { EmbedRouteContext, ThreadRunState } from "./types.mjs";
import { createStubRun } from "./utils.mjs";

/**
 * Register run creation and streaming routes on an embed server Hono app.
 *
 * @experimental Does not follow semver.
 */
export function registerRunRoutes(api: Hono, context: EmbedRouteContext) {
  const threadRunState = new Map<string, ThreadRunState>();

  function getThreadState(threadId: string): ThreadRunState {
    let state = threadRunState.get(threadId);
    if (!state) {
      state = { activeRunId: null, pendingRuns: [] };
      threadRunState.set(threadId, state);
    }
    return state;
  }

  async function waitForRunReady(
    threadId: string,
    runId: string,
    signal?: AbortSignal
  ): Promise<Run | null> {
    const state = getThreadState(threadId);
    const run = state.pendingRuns.find((r) => r.run_id === runId);
    if (!run) return null;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const isHead = state.pendingRuns[0]?.run_id === runId;
      const noActive = !state.activeRunId;
      if (isHead && noActive) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return run;
  }

  api.post(
    "/threads/:thread_id/runs",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    zValidator("json", schemas.RunCreate),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const payload = c.req.valid("json");

      const thread = await context.threads.get(thread_id);
      if (thread == null) return c.json({ error: "Thread not found" }, 404);

      const state = getThreadState(thread_id);
      const multitaskStrategy = payload.multitask_strategy ?? "reject";
      const shouldEnqueue =
        multitaskStrategy === "enqueue" && state.activeRunId != null;

      const run = createStubRun(thread_id, payload, {
        status: shouldEnqueue ? "pending" : "running",
        multitask_strategy: multitaskStrategy,
      });

      state.pendingRuns.push(run);

      c.header("Content-Location", `/threads/${thread_id}/runs/${run.run_id}`);
      return jsonExtra(c, run);
    }
  );

  api.get(
    "/threads/:thread_id/runs/:run_id/stream",
    zValidator(
      "param",
      z.object({
        thread_id: z.string().uuid(),
        run_id: z.string().uuid(),
      })
    ),
    async (c) => {
      const { thread_id, run_id } = c.req.valid("param");

      const thread = await context.threads.get(thread_id);
      if (thread == null) return c.json({ error: "Thread not found" }, 404);

      return streamSSE(c, async (stream) => {
        const signal = getDisconnectAbortSignal(c, stream);
        const state = getThreadState(thread_id);

        try {
          const run = await waitForRunReady(thread_id, run_id, signal);
          if (!run) {
            await stream.writeSSE({
              data: serialiseAsDict({ error: "Run not found" }),
              event: "error",
            });
            return;
          }

          const idx = state.pendingRuns.findIndex((r) => r.run_id === run_id);
          if (idx >= 0) state.pendingRuns.splice(idx, 1);

          state.activeRunId = run_id;
          (run as Run & { status: string }).status = "running";

          try {
            for await (const { event, data } of streamState(run, {
              attempt: 1,
              getGraph: context.getGraph,
              signal,
            })) {
              await stream.writeSSE({ data: serialiseAsDict(data), event });
            }
          } catch (error) {
            await stream.writeSSE({
              data: serialiseAsDict(serializeError(error)),
              event: "error",
            });
          } finally {
            if (state.activeRunId === run_id) {
              state.activeRunId = null;
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          throw err;
        }
      });
    }
  );

  api.post(
    "/threads/:thread_id/runs/:run_id/cancel",
    zValidator(
      "param",
      z.object({
        thread_id: z.string().uuid(),
        run_id: z.string().uuid(),
      })
    ),
    async (c) => {
      const { thread_id, run_id } = c.req.valid("param");
      const state = getThreadState(thread_id);
      const idx = state.pendingRuns.findIndex((r) => r.run_id === run_id);
      if (idx >= 0) {
        state.pendingRuns.splice(idx, 1);
      }
      return new Response(null, { status: 204 });
    }
  );

  api.post(
    "/threads/:thread_id/runs/stream",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    zValidator("json", schemas.RunCreate),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const payload = c.req.valid("json");

      const thread = await context.threads.get(thread_id);
      if (thread == null) return c.json({ error: "Thread not found" }, 404);

      const state = getThreadState(thread_id);
      const run = createStubRun(thread_id, payload);

      c.header("Content-Location", `/threads/${thread_id}/runs/${run.run_id}`);

      return streamSSE(c, async (stream) => {
        const signal = getDisconnectAbortSignal(c, stream);

        state.activeRunId = run.run_id;

        await context.threads.set(thread_id, {
          kind: "patch",
          metadata: {
            graph_id: payload.assistant_id,
            assistant_id: payload.assistant_id,
          },
        });

        try {
          for await (const { event, data } of streamState(run, {
            attempt: 1,
            getGraph: context.getGraph,
            signal,
          })) {
            await stream.writeSSE({ data: serialiseAsDict(data), event });
          }
        } catch (error) {
          await stream.writeSSE({
            data: serialiseAsDict(serializeError(error)),
            event: "error",
          });
        } finally {
          if (state.activeRunId === run.run_id) {
            state.activeRunId = null;
          }
        }
      });
    }
  );

  api.post("/runs/stream", zValidator("json", schemas.RunCreate), async (c) => {
    const payload = c.req.valid("json");
    const threadId = uuidv7();
    const run = createStubRun(threadId, payload);

    c.header("Content-Location", `/threads/${threadId}/runs/${run.run_id}`);

    return streamSSE(c, async (stream) => {
      const signal = getDisconnectAbortSignal(c, stream);

      await context.threads.set(threadId, {
        kind: "put",
        metadata: {
          graph_id: payload.assistant_id,
          assistant_id: payload.assistant_id,
        },
      });

      try {
        try {
          for await (const { event, data } of streamState(run, {
            attempt: 1,
            getGraph: context.getGraph,
            signal,
          })) {
            await stream.writeSSE({ data: serialiseAsDict(data), event });
          }
        } catch (error) {
          await stream.writeSSE({
            data: serialiseAsDict(serializeError(error)),
            event: "error",
          });
        }
      } finally {
        await context.threads.delete(threadId);
      }
    });
  });
}
