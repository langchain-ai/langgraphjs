import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { GRAPHS, NAMESPACE_GRAPH } from "../graph/load.mjs";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { v5 as uuidv5 } from "uuid";
import { v4 as uuid } from "uuid";
import { validateUuid } from "../utils/uuid.mjs";
import { z } from "zod";
import { Run, RunKwargs, Runs, StreamMode } from "../storage/ops.mjs";
import { streamState } from "../stream.mjs";
import { serialiseAsDict } from "../utils/serde.mjs";

const api = new Hono();

// Runs Routes
api.post("/runs/crons", zValidator("json", schemas.CronCreate), async (c) => {
  // Create Thread Cron
  const payload = c.req.valid("json");

  // TODO: implement cron creation
  return c.json({
    cron_id: uuid(),
    thread_id: payload.thread_id,
    assistant_id: payload.assistant_id,
    metadata: payload.metadata,
  });
});

api.post(
  "/runs/crons/search",
  zValidator("json", schemas.CronSearch),
  async (c) => {
    // Search Crons
    const payload = c.req.valid("json");

    // TODO: implement cron search
    return c.json({ crons: [] });
  }
);

api.post(
  "/runs/stream",
  zValidator("json", schemas.RunCreateStateful),
  async (c) => {
    // Stream Run
    const payload = c.req.valid("json");
    const assistantId =
      payload.assistant_id in GRAPHS
        ? uuidv5(NAMESPACE_GRAPH, payload.assistant_id)
        : payload.assistant_id;

    const graph = GRAPHS[assistantId];
  }
);

api.post("/runs/wait", async (c) => {
  // Wait Run
  throw new HTTPException(500, { message: "Not implemented: Wait Run" });
});
api.post("/runs", async (c) => {
  // Create Run
  throw new HTTPException(500, { message: "Not implemented: Create Run" });
});

api.post(
  "/runs/batch",
  zValidator("json", schemas.BatchRunsRequest),
  async (c) => {
    // Batch Runs
    const payload = c.req.valid("json");

    // TODO: implement batch runs
    return c.json({
      runs: [],
    });
  }
);

api.delete("/runs/crons/:cron_id", async (c) => {
  // Delete Cron
  const cronId = validateUuid(c.req.param("cron_id"));

  // TODO: implement cron deletion
  return c.json({});
});

api.get("/threads/:thread_id/runs", async (c) => {
  // List Runs Http
  throw new HTTPException(500, { message: "Not implemented: List Runs Http" });
});

api.post("/threads/:thread_id/runs", async (c) => {
  // Create Run
  throw new HTTPException(500, { message: "Not implemented: Create Run" });
});

api.post("/threads/:thread_id/runs/crons", async (c) => {
  // Create Thread Cron
  throw new HTTPException(500, {
    message: "Not implemented: Create Thread Cron",
  });
});

const createValidRun = async (
  threadId: string | undefined,
  payload: z.infer<typeof schemas.RunCreateStateful>,
  options?: {
    afterSeconds: number | undefined;
    ifNotExists: "reject" | "create" | undefined;
  }
): Promise<Run> => {
  const { assistant_id: assistantId, ...kwargs } = payload;

  const streamMode = Array.isArray(payload.stream_mode)
    ? payload.stream_mode
    : payload.stream_mode != null
      ? [payload.stream_mode]
      : [];
  if (streamMode.length === 0) streamMode.push("values");

  const multitaskStrategy = payload.multitask_strategy ?? "reject";
  const preventInsertInInflight = multitaskStrategy === "reject";

  const config: RunKwargs["config"] = { ...kwargs.config };

  if (kwargs.checkpoint_id) {
    config.configurable ??= {};
    config.configurable.checkpoint_id = kwargs.checkpoint_id;
  }

  if (kwargs.checkpoint) {
    config.configurable ??= {};
    Object.assign(config.configurable, kwargs.checkpoint);
  }

  const [run] = await Runs.put(
    assistantId,
    { ...kwargs, config, stream_mode: streamMode },
    {
      threadId,
      metadata: kwargs.metadata,
      status: "pending",
      multitaskStrategy,
      preventInsertInInflight,
      afterSeconds: options?.afterSeconds,
      ifNotExists: options?.ifNotExists,
    }
  );

  return run;
};

api.post(
  "/threads/:thread_id/runs/stream",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.RunCreateStateful),
  async (c) => {
    // Stream Run
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");

    // TODO: reimplement queue / use worker threads to avoid clogging the asyncio event loop
    const run = await createValidRun(thread_id, payload);
    return streamSSE(c, async (stream) => {
      try {
        for await (const { event, data } of streamState(run)) {
          await stream.writeSSE({ data: serialiseAsDict(data), event });
        }
      } catch (error) {
        console.error(error);
      }
    });
  }
);

api.post(
  "/threads/:thread_id/runs/wait",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.RunCreateStateful),
  async (c) => {
    // Wait Run
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");

    // TODO: reimplement queue / use worker threads to avoid clogging the asyncio event loop
    throw new HTTPException(500, { message: "Not implemented: Wait Run" });
  }
);

api.get("/threads/:thread_id/runs/:run_id", async (c) => {
  // Get Run Http
  throw new HTTPException(500, { message: "Not implemented: Get Run Http" });
});

api.delete("/threads/:thread_id/runs/:run_id", async (c) => {
  // Delete Run
  throw new HTTPException(500, { message: "Not implemented: Delete Run" });
});

api.get("/threads/:thread_id/runs/:run_id/join", async (c) => {
  // Join Run Http
  throw new HTTPException(500, { message: "Not implemented: Join Run Http" });
});

api.post("/threads/:thread_id/runs/:run_id/cancel", async (c) => {
  // Cancel Run Http
  throw new HTTPException(500, { message: "Not implemented: Cancel Run Http" });
});

export default api;
