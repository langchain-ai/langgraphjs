import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";

import * as storage from "../storage/index.mts";
import * as schemas from "../validate.mts";

export const threads = new Hono();

// Threads Routes
threads.post("/", zValidator("json", schemas.ThreadCreate), async (c) => {
  // Create Thread
  const payload = c.req.valid("json");
  const thread = await storage.threads.put(uuid(), {
    metadata: payload.metadata,
    ifExists: payload.if_exists ?? "raise",
  });

  return c.json(thread);
});

threads.post(
  "/search",
  zValidator("json", schemas.ThreadSearchRequest),
  async (c) => {
    // Search Threads
    const payload = c.req.valid("json");
    const result: z.infer<(typeof schemas)["Thread"]>[] = [];

    for await (const item of storage.threads.search({
      limit: payload.limit,
      offset: payload.offset,
      metadata: payload.metadata,
      status: payload.status,
    })) {
      result.push({
        ...item,
        created_at: item.created_at.toISOString(),
        updated_at: item.updated_at.toISOString(),
      });
    }

    return c.json(result);
  }
);

threads.get("/:thread_id/state", async (c) => {
  // Get Latest Thread State
  throw new HTTPException(500, {
    message: "Not implemented: Get Latest Thread State",
  });
});

threads.post("/:thread_id/state", async (c) => {
  // Update Thread State
  throw new HTTPException(500, {
    message: "Not implemented: Update Thread State",
  });
});

threads.patch("/:thread_id/state", async (c) => {
  // Patch Thread State
  throw new HTTPException(500, {
    message: "Not implemented: Patch Thread State",
  });
});

threads.get("/:thread_id/state/:checkpoint_id", async (c) => {
  // Get Thread State At Checkpoint
  throw new HTTPException(500, {
    message: "Not implemented: Get Thread State At Checkpoint",
  });
});

threads.get("/:thread_id/history", async (c) => {
  // Get Thread History
  throw new HTTPException(500, {
    message: "Not implemented: Get Thread History",
  });
});

threads.post("/:thread_id/history", async (c) => {
  // Get Thread History Post
  throw new HTTPException(500, {
    message: "Not implemented: Get Thread History Post",
  });
});

threads.get("/:thread_id", async (c) => {
  // Get Thread
  throw new HTTPException(500, { message: "Not implemented: Get Thread" });
});

threads.delete("/:thread_id", async (c) => {
  // Delete Thread
  throw new HTTPException(500, { message: "Not implemented: Delete Thread" });
});

threads.patch("/:thread_id", async (c) => {
  // Patch Thread
  throw new HTTPException(500, { message: "Not implemented: Patch Thread" });
});

threads.get("/:thread_id/runs", async (c) => {
  // List Runs Http
  throw new HTTPException(500, { message: "Not implemented: List Runs Http" });
});

threads.post("/:thread_id/runs", async (c) => {
  // Create Run
  throw new HTTPException(500, { message: "Not implemented: Create Run" });
});

threads.post("/:thread_id/runs/crons", async (c) => {
  // Create Thread Cron
  throw new HTTPException(500, {
    message: "Not implemented: Create Thread Cron",
  });
});

threads.post("/:thread_id/runs/stream", async (c) => {
  // Stream Run
  throw new HTTPException(500, { message: "Not implemented: Stream Run" });
});

threads.post("/:thread_id/runs/wait", async (c) => {
  // Wait Run
  throw new HTTPException(500, { message: "Not implemented: Wait Run" });
});

threads.get("/:thread_id/runs/:run_id", async (c) => {
  // Get Run Http
  throw new HTTPException(500, { message: "Not implemented: Get Run Http" });
});

threads.delete("/:thread_id/runs/:run_id", async (c) => {
  // Delete Run
  throw new HTTPException(500, { message: "Not implemented: Delete Run" });
});

threads.get("/:thread_id/runs/:run_id/join", async (c) => {
  // Join Run Http
  throw new HTTPException(500, { message: "Not implemented: Join Run Http" });
});

threads.post("/:thread_id/runs/:run_id/cancel", async (c) => {
  // Cancel Run Http
  throw new HTTPException(500, { message: "Not implemented: Cancel Run Http" });
});
