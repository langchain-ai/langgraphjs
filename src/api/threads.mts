import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid4 } from "uuid";

import * as schemas from "../schemas.mjs";
import {
  Checkpoint,
  LangGraphRunnableConfig,
  Threads,
  ThreadState,
} from "../storage/ops.mjs";
import { StateSnapshot } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { validateUuid } from "../utils/uuid.mjs";
import { serializeError } from "../utils/serde.mjs";

const api = new Hono();

const runnableConfigToCheckpoint = (
  config: RunnableConfig | null | undefined
): Checkpoint | null => {
  if (!config || !config.configurable || !config.configurable.thread_id) {
    return null;
  }

  return {
    thread_id: config.configurable.thread_id,
    checkpoint_id: config.configurable.checkpoint_id,
    checkpoint_ns: config.configurable.checkpoint_ns || "",
    checkpoint_map: config.configurable.checkpoint_map || null,
  };
};

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

api.get("/threads/:thread_id/state", async (c) => {
  // Get Latest Thread State
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const state = stateSnapshotToThreadState(
    await Threads.State.get(
      { configurable: { thread_id: threadId } },
      { subgraphs: c.req.query("subgraphs") === "true" }
    )
  );

  return c.json(state);
});

api.post("/threads/:thread_id/state", async (c) => {
  // Update Thread State
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const config: LangGraphRunnableConfig = {
    configurable: { thread_id: threadId },
  };

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
});

api.get("/threads/:thread_id/state/:checkpoint_id", async (c) => {
  // Get Thread State At Checkpoint
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");
  const checkpointId = c.req.param("checkpoint_id");

  const state = stateSnapshotToThreadState(
    await Threads.State.get(
      {
        configurable: {
          thread_id: threadId,
          checkpoint_id: checkpointId,
        },
      },
      { subgraphs: c.req.query("subgraphs") === "true" }
    )
  );

  return c.json(state);
});

api.post("/threads/:thread_id/state/checkpoint", async (c) => {
  // Get Thread State At Checkpoint Post
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const state = stateSnapshotToThreadState(
    await Threads.State.get(
      {
        configurable: {
          thread_id: threadId,
          ...payload.checkpoint,
        },
      },
      payload.subgraphs ?? false
    )
  );

  return c.json(state);
});

api.get("/threads/:thread_id/history", async (c) => {
  // Get Thread History
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const limit = parseInt(c.req.query("limit") ?? "10");
  const before = c.req.query("before");

  const states = await Threads.State.list(threadId, {
    limit,
    before,
  });

  return c.json(states.map(stateSnapshotToThreadState));
});

api.post("/threads/:thread_id/history", async (c) => {
  // Get Thread History Post
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  if (payload.checkpoint) {
    Object.assign(config.configurable, payload.checkpoint);
  }

  const states = await Threads.State.list(threadId, {
    limit: parseInt(payload.limit ?? "10"),
    before: payload.before,
    metadata: payload.metadata,
  });

  return c.json(states.map(stateSnapshotToThreadState));
});

api.get("/threads/:thread_id", async (c) => {
  // Get Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const thread = await Threads.get(threadId);
  return c.json(thread);
});

api.delete("/threads/:thread_id", async (c) => {
  // Delete Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  await Threads.delete(threadId);
  return new Response(null, { status: 204 });
});

api.patch("/threads/:thread_id", async (c) => {
  // Patch Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const thread = await Threads.patch(threadId, {
    metadata: payload.metadata,
  });

  return c.json(thread);
});

api.post("/threads/:thread_id/copy", async (c) => {
  // Copy Thread
  const threadId = c.req.param("thread_id");
  const thread = await Threads.copy(threadId);
  return c.json(thread);
});

export default api;
