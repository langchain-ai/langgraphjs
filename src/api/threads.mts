import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid4 } from "uuid";

import * as schemas from "../schemas.mjs";
import {
  Checkpoint,
  RunnableConfig,
  Threads,
  ThreadState,
} from "../storage/ops.mjs";
import { StateSnapshot } from "@langchain/langgraph";
import { serializeError } from "../utils/serde.mjs";
import { runnableConfigToCheckpoint } from "../utils/config.mjs";
import { z } from "zod";

const api = new Hono();

const stateSnapshotToThreadState = (state: StateSnapshot): ThreadState => {
  return {
    values: state.values,
    next: state.next,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      error: serializeError(task.error).message,
      interrupts: task.interrupts,
      // TODO: too many type assertions, check if this is actually correct
      checkpoint:
        task.state != null && "configurable" in task.state
          ? ((task.state.configurable as Checkpoint) ?? null)
          : null,
      state: task.state as ThreadState | undefined,
      // result: task.result,
    })),
    metadata: state.metadata as Record<string, unknown> | undefined,
    created_at: state.createdAt ? new Date(state.createdAt) : null,
    checkpoint: runnableConfigToCheckpoint(state.config),
    parent_checkpoint: runnableConfigToCheckpoint(state.parentConfig),
  };
};

// Threads Routes
api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
  // Create Thread
  const payload = c.req.valid("json");
  const thread = await Threads.put(payload.thread_id || uuid4(), {
    metadata: payload.metadata,
    if_exists: payload.if_exists ?? "raise",
  });

  return c.json(thread);
});

api.post(
  "/threads/search",
  zValidator("json", schemas.ThreadSearchRequest),
  async (c) => {
    // Search Threads
    const payload = c.req.valid("json");
    const result: unknown[] = [];

    for await (const item of Threads.search({
      status: payload.status,
      values: payload.values,
      metadata: payload.metadata,
      limit: payload.limit ?? 10,
      offset: payload.offset ?? 0,
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

api.get(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({
      subgraphs: z
        .union([z.literal("true"), z.literal("false")])
        .optional()
        .default("false")
        .transform((value) => value === "true"),
    })
  ),
  async (c) => {
    // Get Latest Thread State
    const { thread_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");

    const state = stateSnapshotToThreadState(
      await Threads.State.get({ configurable: { thread_id } }, { subgraphs })
    );

    return c.json(state);
  }
);

api.post(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      values: z.union([
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())),
      ]),
      as_node: z.string().optional(),
      checkpoint_id: z.string().optional(),
      checkpoint: z.record(z.string(), z.unknown()).optional(),
    })
  ),
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

    const inserted = await Threads.State.post(
      config,
      payload.values,
      payload.as_node
    );

    return c.json(inserted);
  }
);

api.get(
  "/threads/:thread_id/state/:checkpoint_id",
  zValidator(
    "param",
    z.object({ thread_id: z.string().uuid(), checkpoint_id: z.string().uuid() })
  ),
  zValidator(
    "query",
    z.object({
      subgraphs: z
        .union([z.literal("true"), z.literal("false")])
        .optional()
        .default("false")
        .transform((value) => value === "true"),
    })
  ),
  async (c) => {
    // Get Thread State At Checkpoint
    const { thread_id, checkpoint_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");
    const state = stateSnapshotToThreadState(
      await Threads.State.get(
        { configurable: { thread_id, checkpoint_id } },
        { subgraphs }
      )
    );

    return c.json(state);
  }
);

api.post(
  "/threads/:thread_id/state/checkpoint",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      subgraphs: z
        .union([z.literal("true"), z.literal("false")])
        .optional()
        .default("false")
        .transform((value) => value === "true"),
      checkpoint: z.object({
        checkpoint_id: z.string().uuid(),
        checkpoint_ns: z.string().optional(),
        checkpoint_map: z.record(z.string(), z.unknown()).optional(),
      }),
    })
  ),
  async (c) => {
    // Get Thread State At Checkpoint Post
    const { thread_id } = c.req.valid("param");
    const { checkpoint, subgraphs } = c.req.valid("json");

    const state = stateSnapshotToThreadState(
      await Threads.State.get(
        { configurable: { thread_id, ...checkpoint } },
        { subgraphs }
      )
    );

    return c.json(state);
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

    const states = await Threads.State.list(
      { configurable: { thread_id, checkpoint_ns: "" } },
      { limit, before }
    );
    return c.json(states.map(stateSnapshotToThreadState));
  }
);

api.post(
  "/threads/:thread_id/history",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      limit: z.number().optional().default(10),
      before: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      checkpoint: z
        .object({
          checkpoint_id: z.string().uuid(),
          checkpoint_ns: z.string().optional(),
          checkpoint_map: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
  ),
  async (c) => {
    // Get Thread History Post
    const { thread_id } = c.req.valid("param");
    const { limit, before, metadata, checkpoint } = c.req.valid("json");

    const states = await Threads.State.list(
      { configurable: { thread_id, checkpoint_ns: "", ...checkpoint } },
      { limit, before, metadata }
    );

    return c.json(states.map(stateSnapshotToThreadState));
  }
);

api.get(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Get Thread
    const { thread_id } = c.req.valid("param");
    return c.json(await Threads.get(thread_id));
  }
);

api.delete(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Delete Thread
    const { thread_id } = c.req.valid("param");
    await Threads.delete(thread_id);
    return new Response(null, { status: 204 });
  }
);

api.patch(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", z.object({ metadata: z.record(z.string(), z.unknown()) })),
  async (c) => {
    // Patch Thread
    const { thread_id } = c.req.valid("param");
    const { metadata } = c.req.valid("json");
    return c.json(await Threads.patch(thread_id, { metadata }));
  }
);

api.post(
  "/threads/:thread_id/copy",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Copy Thread
    const { thread_id } = c.req.valid("param");
    return c.json(await Threads.copy(thread_id));
  }
);

export default api;
