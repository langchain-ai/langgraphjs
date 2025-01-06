import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { GRAPHS, NAMESPACE_GRAPH } from "../graph/load.mjs";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { v5 as uuidv5 } from "uuid";
import { v4 as uuid } from "uuid";
import { validateUuid } from "../utils/uuid.mjs";

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

api.post("/runs/stream", zValidator("json", schemas.RunStream), async (c) => {
  // Stream Run
  const payload = c.req.valid("json");
  const assistantId =
    payload.assistant_id in GRAPHS
      ? uuidv5(NAMESPACE_GRAPH, payload.assistant_id)
      : payload.assistant_id;

  const graph = GRAPHS[assistantId];
});

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

api.post(
  "/threads/:thread_id/runs/stream",
  zValidator("json", schemas.RunStream),
  async (c) => {
    // Stream Run
    const threadId = c.req.param("thread_id");
    validateUuid(threadId, "Invalid thread ID: must be a UUID");
    const payload = c.req.valid("json");

    throw new HTTPException(500, { message: "Not implemented: Stream Run" });
  }
);

api.post("/threads/:thread_id/runs/wait", async (c) => {
  // Wait Run
  throw new HTTPException(500, { message: "Not implemented: Wait Run" });
});

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
