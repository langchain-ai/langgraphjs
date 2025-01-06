import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { GRAPHS, NAMESPACE_GRAPH } from "../graph/load.mts";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../validate.mjs";
import { v5 as uuidv5 } from "uuid";
import { v4 as uuid } from "uuid";
import { validateUuid } from "../utils/uuid.mts";

export const runs = new Hono();

// Runs Routes
runs.post("/crons", zValidator("json", schemas.CronCreate), async (c) => {
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

runs.post(
  "/crons/search",
  zValidator("json", schemas.CronSearch),
  async (c) => {
    // Search Crons
    const payload = c.req.valid("json");

    // TODO: implement cron search
    return c.json({
      crons: [],
    });
  }
);

runs.post("/stream", zValidator("json", schemas.RunStream), async (c) => {
  // Stream Run
  const payload = c.req.valid("json");
  const assistantId =
    payload.assistant_id in GRAPHS
      ? uuidv5(NAMESPACE_GRAPH, payload.assistant_id)
      : payload.assistant_id;

  const graph = GRAPHS[assistantId];
});

runs.post("/wait", async (c) => {
  // Wait Run
  throw new HTTPException(500, { message: "Not implemented: Wait Run" });
});
runs.post("/", async (c) => {
  // Create Run
  throw new HTTPException(500, { message: "Not implemented: Create Run" });
});

runs.post("/batch", zValidator("json", schemas.BatchRunsRequest), async (c) => {
  // Batch Runs
  const payload = c.req.valid("json");

  // TODO: implement batch runs
  return c.json({
    runs: [],
  });
});

runs.delete("/crons/:cron_id", async (c) => {
  // Delete Cron
  const cronId = validateUuid(c.req.param("cron_id"));

  // TODO: implement cron deletion
  return c.json({});
});
