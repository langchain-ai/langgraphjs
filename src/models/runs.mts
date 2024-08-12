import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as storage from "../storage/index.mjs";
import { GRAPHS, NAMESPACE_GRAPH } from "../graph.mts";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../validate.mjs";
import { v5 as uuidv5 } from "uuid";

export const runs = new Hono();

// Runs Routes
runs.post("/crons", async (c) => {
  // Create Cron
  throw new HTTPException(500, { message: "Not implemented: Create Cron" });
});

runs.post("/crons/search", async (c) => {
  // Search Crons
  throw new HTTPException(500, { message: "Not implemented: Search Crons" });
});

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

runs.post("/batch", async (c) => {
  // Create Batch Run
  throw new HTTPException(500, {
    message: "Not implemented: Create Batch Run",
  });
});

runs.delete("/crons/:cron_id", async (c) => {
  // Delete Cron
  throw new HTTPException(500, { message: "Not implemented: Delete Cron" });
});
