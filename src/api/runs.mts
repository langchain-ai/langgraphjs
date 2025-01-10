import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { getAssistantId } from "../graph/load.mjs";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { z } from "zod";
import { Run, RunKwargs, Runs, Threads } from "../storage/ops.mjs";
import { serialiseAsDict } from "../utils/serde.mjs";
import {
  getDisconnectAbortSignal,
  jsonExtra,
  waitKeepAlive,
} from "../utils/hono.mjs";
import { logger } from "../logging.mjs";
import { v4 as uuid4 } from "uuid";

const api = new Hono();

const createValidRun = async (
  threadId: string | undefined,
  payload: z.infer<typeof schemas.RunCreate>
): Promise<Run> => {
  const { assistant_id: assistantId, ...run } = payload;
  const runId = uuid4();

  const streamMode = Array.isArray(payload.stream_mode)
    ? payload.stream_mode
    : payload.stream_mode != null
      ? [payload.stream_mode]
      : [];
  if (streamMode.length === 0) streamMode.push("values");

  const multitaskStrategy = payload.multitask_strategy ?? "reject";
  const preventInsertInInflight = multitaskStrategy === "reject";

  const config: RunKwargs["config"] = { ...run.config };

  if (run.checkpoint_id) {
    config.configurable ??= {};
    config.configurable.checkpoint_id = run.checkpoint_id;
  }

  if (run.checkpoint) {
    config.configurable ??= {};
    Object.assign(config.configurable, run.checkpoint);
  }

  let feedbackKeys =
    run.feedback_keys != null
      ? Array.isArray(run.feedback_keys)
        ? run.feedback_keys
        : [run.feedback_keys]
      : undefined;
  if (!feedbackKeys?.length) feedbackKeys = undefined;

  const [first, ...inflight] = await Runs.put(
    runId,
    getAssistantId(assistantId),
    {
      input: run.input,
      command: run.command,
      config,
      stream_mode: streamMode,
      interrupt_before: run.interrupt_before,
      interrupt_after: run.interrupt_after,
      webhook: run.webhook,
      feedback_keys: feedbackKeys,
      temporary:
        threadId == null && (run.on_completion ?? "delete") === "delete",
      subgraphs: run.stream_subgraphs ?? false,
    },
    {
      threadId,
      metadata: run.metadata,
      status: "pending",
      multitaskStrategy,
      preventInsertInInflight,
      afterSeconds: payload.after_seconds,
      ifNotExists: payload.if_not_exists,
    }
  );

  if (first?.run_id === runId) {
    logger.info("Created run", { run_id: runId, thread_id: threadId });
    if (
      (multitaskStrategy === "interrupt" || multitaskStrategy === "rollback") &&
      inflight.length > 0
    ) {
      try {
        await Runs.cancel(
          threadId,
          inflight.map((run) => run.run_id),
          { action: multitaskStrategy }
        );
      } catch (error) {
        logger.warn(
          "Failed to cancel inflight runs, might be already cancelled",
          {
            error,
            run_ids: inflight.map((run) => run.run_id),
            thread_id: threadId,
          }
        );
      }
    }

    return first;
  } else if (multitaskStrategy === "reject") {
    throw new HTTPException(409, {
      message:
        "Thread is already running a task. Wait for it to finish or choose a different multitask strategy.",
    });
  }

  throw new HTTPException(500, {
    message: "Unreachable state when creating run",
  });
};

api.post("/runs/crons", zValidator("json", schemas.CronCreate), async () => {
  // Create Thread Cron
  throw new HTTPException(500, { message: "Not implemented" });
});

api.post(
  "/runs/crons/search",
  zValidator("json", schemas.CronSearch),
  async () => {
    // Search Crons
    throw new HTTPException(500, { message: "Not implemented" });
  }
);

api.delete(
  "/runs/crons/:cron_id",
  zValidator("param", z.object({ cron_id: z.string().uuid() })),
  async () => {
    // Delete Cron
    throw new HTTPException(500, { message: "Not implemented" });
  }
);

api.post(
  "/threads/:thread_id/runs/crons",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.CronCreate),
  async () => {
    // Create Thread Cron
    throw new HTTPException(500, { message: "Not implemented" });
  }
);

api.post("/runs/stream", zValidator("json", schemas.RunCreate), async (c) => {
  // Stream Run
  const payload = c.req.valid("json");

  const run = await createValidRun(undefined, payload);
  return streamSSE(c, async (stream) => {
    const cancelOnDisconnect =
      payload.on_disconnect === "cancel"
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

    try {
      for await (const { event, data } of Runs.Stream.join(
        run.run_id,
        undefined,
        { cancelOnDisconnect }
      )) {
        await stream.writeSSE({ data: serialiseAsDict(data), event });
      }
    } catch (error) {
      logger.error("Error streaming run", { error });
    }
  });
});

api.post("/runs/wait", zValidator("json", schemas.RunCreate), async (c) => {
  // Wait Run
  const payload = c.req.valid("json");
  const run = await createValidRun(undefined, payload);
  return waitKeepAlive(c, Runs.wait(run.run_id, undefined));
});

api.post("/runs", zValidator("json", schemas.RunCreate), async (c) => {
  // Create Stateless Run
  const payload = c.req.valid("json");
  const run = await createValidRun(undefined, payload);
  return jsonExtra(c, run);
});

api.post(
  "/runs/batch",
  zValidator("json", schemas.RunBatchCreate),
  async (c) => {
    // Batch Runs
    const payload = c.req.valid("json");
    const runs = await Promise.all(
      payload.map((run) => createValidRun(undefined, run))
    );
    return jsonExtra(c, runs);
  }
);

api.get(
  "/threads/:thread_id/runs",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({
      limit: z.coerce.number().nullish(),
      offset: z.coerce.number().nullish(),
      status: z.string().nullish(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    })
  ),
  async (c) => {
    // List runs
    const { thread_id } = c.req.valid("param");
    const { limit, offset, status, metadata } = c.req.valid("query");

    const [runs] = await Promise.all([
      Runs.search(thread_id, {
        limit,
        offset,
        status,
        metadata,
      }),
      Threads.get(thread_id),
    ]);

    return jsonExtra(c, runs);
  }
);

api.post(
  "/threads/:thread_id/runs",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.RunCreate),
  async (c) => {
    // Create Run
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");

    const run = await createValidRun(thread_id, payload);
    return jsonExtra(c, run);
  }
);

api.post(
  "/threads/:thread_id/runs/stream",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.RunCreate),
  async (c) => {
    // Stream Run
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");

    const run = await createValidRun(thread_id, payload);
    return streamSSE(c, async (stream) => {
      const cancelOnDisconnect =
        payload.on_disconnect === "cancel"
          ? getDisconnectAbortSignal(c, stream)
          : undefined;

      try {
        for await (const { event, data } of Runs.Stream.join(
          run.run_id,
          thread_id,
          { cancelOnDisconnect }
        )) {
          await stream.writeSSE({ data: serialiseAsDict(data), event });
        }
      } catch (error) {
        logger.error("Error streaming run", { error });
      }
    });
  }
);

api.post(
  "/threads/:thread_id/runs/wait",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.RunCreate),
  async (c) => {
    // Wait Run
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");

    const run = await createValidRun(thread_id, payload);
    return waitKeepAlive(c, Runs.join(run.run_id, thread_id));
  }
);

api.get(
  "/threads/:thread_id/runs/:run_id",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })
  ),
  async (c) => {
    const { thread_id, run_id } = c.req.valid("param");
    const [run] = await Promise.all([
      Runs.get(run_id, thread_id),
      Threads.get(thread_id),
    ]);

    return jsonExtra(c, run);
  }
);

api.delete(
  "/threads/:thread_id/runs/:run_id",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })
  ),
  async (c) => {
    // Delete Run
    const { thread_id, run_id } = c.req.valid("param");
    await Runs.delete(run_id, thread_id);
    return c.body(null, 204);
  }
);

api.get(
  "/threads/:thread_id/runs/:run_id/join",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })
  ),
  async (c) => {
    // Join Run Http
    const { thread_id, run_id } = c.req.valid("param");
    return jsonExtra(c, await Runs.join(run_id, thread_id));
  }
);

api.get(
  "/threads/:thread_id/runs/:run_id/stream",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })
  ),
  zValidator(
    "query",
    z.object({ cancel_on_disconnect: schemas.coercedBoolean.optional() })
  ),
  async (c) => {
    // Stream Run Http
    const { thread_id, run_id } = c.req.valid("param");
    const { cancel_on_disconnect } = c.req.valid("query");
    return streamSSE(c, async (stream) => {
      const signal = cancel_on_disconnect
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

      for await (const { event, data } of Runs.Stream.join(run_id, thread_id, {
        cancelOnDisconnect: signal,
      })) {
        await stream.writeSSE({ data: serialiseAsDict(data), event });
      }
    });
  }
);

api.post(
  "/threads/:thread_id/runs/:run_id/cancel",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })
  ),
  zValidator(
    "query",
    z.object({
      wait: z.coerce.boolean().optional().default(false),
      action: z.enum(["interrupt", "rollback"]).optional().default("interrupt"),
    })
  ),
  async (c) => {
    // Cancel Run Http
    const { thread_id, run_id } = c.req.valid("param");
    const { wait, action } = c.req.valid("query");

    await Runs.cancel(thread_id, [run_id], { action });
    if (wait) await Runs.join(run_id, thread_id);
    return c.body(null, wait ? 204 : 202);
  }
);

export default api;
