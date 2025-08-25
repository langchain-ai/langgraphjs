import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid4 } from "uuid";

import { z } from "zod";
import * as schemas from "../schemas.mjs";
import { stateSnapshotToThreadState } from "../state.mjs";
import { threads } from "../storage/context.mjs";
import type { RunnableConfig } from "../storage/types.mjs";
import { jsonExtra } from "../utils/hono.mjs";

const api = new Hono();

// Threads Routes
api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
  // Create Thread
  const payload = c.req.valid("json");
  const thread = await threads().put(
    payload.thread_id || uuid4(),
    { metadata: payload.metadata, if_exists: payload.if_exists ?? "raise" },
    c.var.auth
  );

  if (payload.supersteps?.length) {
    await threads().state.bulk(
      { configurable: { thread_id: thread.thread_id } },
      payload.supersteps,
      c.var.auth
    );
  }

  return jsonExtra(c, thread);
});

api.post(
  "/threads/search",
  zValidator("json", schemas.ThreadSearchRequest),
  async (c) => {
    // Search Threads
    const payload = c.req.valid("json");
    const result: unknown[] = [];

    let total = 0;
    for await (const item of threads().search(
      {
        status: payload.status,
        values: payload.values,
        metadata: payload.metadata,
        limit: payload.limit ?? 10,
        offset: payload.offset ?? 0,
        sort_by: payload.sort_by ?? "created_at",
        sort_order: payload.sort_order ?? "desc",
      },
      c.var.auth
    )) {
      result.push({
        ...item.thread,
        created_at: item.thread.created_at.toISOString(),
        updated_at: item.thread.updated_at.toISOString(),
      });
      // Only set total if it's the first item
      if (total === 0) {
        total = item.total;
      }
    }
    c.res.headers.set("X-Pagination-Total", total.toString());
    return jsonExtra(c, result);
  }
);

api.get(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({ subgraphs: schemas.coercedBoolean.optional() })
  ),
  async (c) => {
    // Get Latest Thread State
    const { thread_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");

    const state = stateSnapshotToThreadState(
      await threads().state.get(
        { configurable: { thread_id } },
        { subgraphs },
        c.var.auth
      )
    );

    return jsonExtra(c, state);
  }
);

api.post(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.ThreadStateUpdate),
  async (c) => {
    // Update Thread State
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");
    const config: RunnableConfig = { configurable: { thread_id } };

    if (payload.checkpoint_id) {
      config.configurable ??= {};
      config.configurable.checkpoint_id = payload.checkpoint_id;
    }
    if (payload.checkpoint) {
      config.configurable ??= {};
      Object.assign(config.configurable, payload.checkpoint);
    }

    const inserted = await threads().state.post(
      config,
      payload.values,
      payload.as_node,
      c.var.auth
    );

    return jsonExtra(c, inserted);
  }
);

api.get(
  "/threads/:thread_id/state/:checkpoint_id",
  zValidator(
    "param",
    z.object({
      thread_id: z.string().uuid(),
      checkpoint_id: z.string().uuid(),
    })
  ),
  zValidator(
    "query",
    z.object({ subgraphs: schemas.coercedBoolean.optional() })
  ),
  async (c) => {
    // Get Thread State At Checkpoint
    const { thread_id, checkpoint_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");
    const state = stateSnapshotToThreadState(
      await threads().state.get(
        { configurable: { thread_id, checkpoint_id } },
        { subgraphs },
        c.var.auth
      )
    );

    return jsonExtra(c, state);
  }
);

api.post(
  "/threads/:thread_id/state/checkpoint",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      subgraphs: schemas.coercedBoolean.optional(),
      checkpoint: schemas.CheckpointSchema.nullish(),
    })
  ),
  async (c) => {
    // Get Thread State At Checkpoint Post
    const { thread_id } = c.req.valid("param");
    const { checkpoint, subgraphs } = c.req.valid("json");

    const state = stateSnapshotToThreadState(
      await threads().state.get(
        { configurable: { thread_id, ...checkpoint } },
        { subgraphs },
        c.var.auth
      )
    );

    return jsonExtra(c, state);
  }
);

api.get(
  "/threads/:thread_id/history",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({
      limit: z
        .string()
        .optional()
        .default("10")
        .transform((value) => parseInt(value, 10)),
      before: z.string().optional(),
    })
  ),
  async (c) => {
    // Get Thread History
    const { thread_id } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");

    const states = await threads().state.list(
      { configurable: { thread_id, checkpoint_ns: "" } },
      { limit, before },
      c.var.auth
    );
    return jsonExtra(c, states.map(stateSnapshotToThreadState));
  }
);

api.post(
  "/threads/:thread_id/history",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.ThreadHistoryRequest),
  async (c) => {
    // Get Thread History Post
    const { thread_id } = c.req.valid("param");
    const { limit, before, metadata, checkpoint } = c.req.valid("json");

    const states = await threads().state.list(
      { configurable: { thread_id, checkpoint_ns: "", ...checkpoint } },
      { limit, before, metadata },
      c.var.auth
    );

    return jsonExtra(c, states.map(stateSnapshotToThreadState));
  }
);

api.get(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Get Thread
    const { thread_id } = c.req.valid("param");
    return jsonExtra(c, await threads().get(thread_id, c.var.auth));
  }
);

api.delete(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Delete Thread
    const { thread_id } = c.req.valid("param");
    await threads().delete(thread_id, c.var.auth);
    return new Response(null, { status: 204 });
  }
);

api.patch(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", schemas.ThreadPatchRequest),
  async (c) => {
    // Patch Thread
    const { thread_id } = c.req.valid("param");
    const { metadata } = c.req.valid("json");
    return jsonExtra(
      c,
      await threads().patch(thread_id, { metadata }, c.var.auth)
    );
  }
);

api.post(
  "/threads/:thread_id/copy",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Copy Thread
    const { thread_id } = c.req.valid("param");
    return jsonExtra(c, await threads().copy(thread_id, c.var.auth));
  }
);

export default api;
