import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { v4 as uuid4 } from "uuid";
import { z } from "zod/v3";
import type { AuthContext } from "../auth/index.mjs";
import { getAssistantId } from "../graph/load.mjs";
import { logError, logger } from "../logging.mjs";
import * as schemas from "../schemas.mjs";
import { runs, threads } from "../storage/context.mjs";
import type { Run, RunKwargs } from "../storage/types.mjs";
import {
  getDisconnectAbortSignal,
  jsonExtra,
  waitKeepAlive,
} from "../utils/hono.mjs";
import { serialiseAsDict } from "../utils/serde.mjs";

const api = new Hono();

const createValidRun = async (
  threadId: string | undefined,
  payload: z.infer<typeof schemas.RunCreate>,
  kwargs: {
    auth: AuthContext | undefined;
    headers: Headers | undefined;
  }
): Promise<Run> => {
  const { assistant_id: assistantId, ...run } = payload;
  const { auth, headers } = kwargs ?? {};
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

  if (run.langsmith_tracer) {
    config.configurable ??= {};
    Object.assign(config.configurable, {
      langsmith_project: run.langsmith_tracer.project_name,
      langsmith_example_id: run.langsmith_tracer.example_id,
    });
  }

  if (headers) {
    for (const [rawKey, value] of headers.entries()) {
      const key = rawKey.toLowerCase();
      if (key.startsWith("x-")) {
        if (["x-api-key", "x-tenant-id", "x-service-key"].includes(key)) {
          continue;
        }

        config.configurable ??= {};
        config.configurable[key] = value;
      } else if (key === "user-agent") {
        config.configurable ??= {};
        config.configurable[key] = value;
      }
    }
  }

  let userId: string | undefined;
  if (auth) {
    userId = auth.user.identity ?? auth.user.id;
    config.configurable ??= {};
    config.configurable["langgraph_auth_user"] = auth.user;
    config.configurable["langgraph_auth_user_id"] = userId;
    config.configurable["langgraph_auth_permissions"] = auth.scopes;
  }

  let feedbackKeys =
    run.feedback_keys != null
      ? Array.isArray(run.feedback_keys)
        ? run.feedback_keys
        : [run.feedback_keys]
      : undefined;
  if (!feedbackKeys?.length) feedbackKeys = undefined;

  const [first, ...inflight] = await runs().put(
    runId,
    getAssistantId(assistantId),
    {
      input: run.input,
      command: run.command,
      config,
      context: run.context,
      stream_mode: streamMode,
      interrupt_before: run.interrupt_before,
      interrupt_after: run.interrupt_after,
      webhook: run.webhook,
      feedback_keys: feedbackKeys,
      temporary:
        threadId == null && (run.on_completion ?? "delete") === "delete",
      subgraphs: run.stream_subgraphs ?? false,
      resumable: run.stream_resumable ?? false,
    },
    {
      threadId,
      userId,
      metadata: run.metadata,
      status: "pending",
      multitaskStrategy,
      preventInsertInInflight,
      afterSeconds: payload.after_seconds,
      ifNotExists: payload.if_not_exists,
    },
    auth
  );

  if (first?.run_id === runId) {
    logger.info("Created run", { run_id: runId, thread_id: threadId });
    if (
      (multitaskStrategy === "interrupt" || multitaskStrategy === "rollback") &&
      inflight.length > 0
    ) {
      try {
        await runs().cancel(
          threadId,
          inflight.map((run) => run.run_id),
          { action: multitaskStrategy },
          auth
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
    throw new HTTPException(422, {
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
  // Stream Stateless Run
  const payload = c.req.valid("json");

  const run = await createValidRun(undefined, payload, {
    auth: c.var.auth,
    headers: c.req.raw.headers,
  });

  c.header("Content-Location", `/runs/${run.run_id}`);
  return streamSSE(c, async (stream) => {
    const cancelOnDisconnect =
      payload.on_disconnect === "cancel"
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

    try {
      for await (const { event, data } of runs().stream.join(
        run.run_id,
        undefined,
        {
          cancelOnDisconnect,
          lastEventId: run.kwargs.resumable ? "-1" : undefined,
          ignore404: true,
        },
        c.var.auth
      )) {
        await stream.writeSSE({ data: serialiseAsDict(data), event });
      }
    } catch (error) {
      logError(error, { prefix: "Error streaming run" });
    }
  });
});

// TODO: port to Python API
api.get(
  "/runs/:run_id/stream",
  zValidator("param", z.object({ run_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({ cancel_on_disconnect: schemas.coercedBoolean.optional() })
  ),
  async (c) => {
    const { run_id } = c.req.valid("param");
    const query = c.req.valid("query");

    const lastEventId = c.req.header("Last-Event-ID") || undefined;
    c.header("Content-Location", `/runs/${run_id}`);
    return streamSSE(c, async (stream) => {
      const cancelOnDisconnect = query.cancel_on_disconnect
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

      try {
        for await (const { id, event, data } of runs().stream.join(
          run_id,
          undefined,
          { cancelOnDisconnect, lastEventId, ignore404: true },
          c.var.auth
        )) {
          await stream.writeSSE({ id, data: serialiseAsDict(data), event });
        }
      } catch (error) {
        logError(error, { prefix: "Error streaming run" });
      }
    });
  }
);

api.post("/runs/wait", zValidator("json", schemas.RunCreate), async (c) => {
  // Wait Stateless Run
  const payload = c.req.valid("json");
  const run = await createValidRun(undefined, payload, {
    auth: c.var.auth,
    headers: c.req.raw.headers,
  });
  c.header("Content-Location", `/runs/${run.run_id}`);
  return waitKeepAlive(c, runs().wait(run.run_id, undefined, c.var.auth));
});

api.post("/runs", zValidator("json", schemas.RunCreate), async (c) => {
  // Create Stateless Run
  const payload = c.req.valid("json");
  const run = await createValidRun(undefined, payload, {
    auth: c.var.auth,
    headers: c.req.raw.headers,
  });
  c.header("Content-Location", `/runs/${run.run_id}`);
  return jsonExtra(c, run);
});

api.post(
  "/runs/batch",
  zValidator("json", schemas.RunBatchCreate),
  async (c) => {
    // Batch Runs
    const payload = c.req.valid("json");
    const runs = await Promise.all(
      payload.map((run) =>
        createValidRun(undefined, run, {
          auth: c.var.auth,
          headers: c.req.raw.headers,
        })
      )
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

    const [runsResponse] = await Promise.all([
      runs().search(thread_id, { limit, offset, status, metadata }, c.var.auth),
      threads().get(thread_id, c.var.auth),
    ]);

    return jsonExtra(c, runsResponse);
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

    const run = await createValidRun(thread_id, payload, {
      auth: c.var.auth,
      headers: c.req.raw.headers,
    });
    c.header("Content-Location", `/threads/${thread_id}/runs/${run.run_id}`);
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

    const run = await createValidRun(thread_id, payload, {
      auth: c.var.auth,
      headers: c.req.raw.headers,
    });

    c.header("Content-Location", `/threads/${thread_id}/runs/${run.run_id}`);
    return streamSSE(c, async (stream) => {
      const cancelOnDisconnect =
        payload.on_disconnect === "cancel"
          ? getDisconnectAbortSignal(c, stream)
          : undefined;

      try {
        for await (const { id, event, data } of runs().stream.join(
          run.run_id,
          thread_id,
          {
            cancelOnDisconnect,
            lastEventId: run.kwargs.resumable ? "-1" : undefined,
          },
          c.var.auth
        )) {
          await stream.writeSSE({ id, data: serialiseAsDict(data), event });
        }
      } catch (error) {
        logError(error, { prefix: "Error streaming run" });
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

    const run = await createValidRun(thread_id, payload, {
      auth: c.var.auth,
      headers: c.req.raw.headers,
    });

    c.header("Content-Location", `/threads/${thread_id}/runs/${run.run_id}`);
    return waitKeepAlive(c, runs().join(run.run_id, thread_id, c.var.auth));
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
      runs().get(run_id, thread_id, c.var.auth),
      threads().get(thread_id, c.var.auth),
    ]);

    if (run == null) throw new HTTPException(404, { message: "Run not found" });
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
    await runs().delete(run_id, thread_id, c.var.auth);
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
    return jsonExtra(c, await runs().join(run_id, thread_id, c.var.auth));
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
    const lastEventId = c.req.header("Last-Event-ID") || undefined;

    return streamSSE(c, async (stream) => {
      const signal = cancel_on_disconnect
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

      for await (const { id, event, data } of runs().stream.join(
        run_id,
        thread_id,
        { cancelOnDisconnect: signal, lastEventId },
        c.var.auth
      )) {
        await stream.writeSSE({ id, data: serialiseAsDict(data), event });
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

    await runs().cancel(thread_id, [run_id], { action }, c.var.auth);
    if (wait) await runs().join(run_id, thread_id, c.var.auth);
    return c.body(null, wait ? 204 : 202);
  }
);

export default api;
