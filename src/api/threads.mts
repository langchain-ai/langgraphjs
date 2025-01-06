import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid, validate } from "uuid";
import { HTTPException } from "hono/http-exception";

import * as schemas from "../validate.mts";
import { Checkpoint, Threads, ThreadState } from "../storage/ops.mts";
import { StateSnapshot } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";

export const threads = new Hono();

const validateUuid = (value: string, message: string) => {
  if (!validate(value)) {
    throw new HTTPException(400, { message });
  }
};

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
      error: task.error,
      interrupts: task.interrupts,
      checkpoint: task.state?.configurable,
      state: task.state,
      result: task.result,
    })),
    metadata: state.metadata,
    created_at: state.createdAt,
    checkpoint: runnableConfigToCheckpoint(state.config),
    parent_checkpoint: runnableConfigToCheckpoint(state.parentConfig),
  };
};

// Threads Routes
threads.post("/", zValidator("json", schemas.ThreadCreate), async (c) => {
  // Create Thread
  const payload = c.req.valid("json");
  const thread = await Threads.put(payload.thread_id || uuid(), {
    metadata: payload.metadata,
    if_exists: payload.if_exists ?? "raise",
  });

  return c.json(thread);
});

threads.post(
  "/search",
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

threads.get("/:thread_id/state", async (c) => {
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

threads.post("/:thread_id/state", async (c) => {
  // Update Thread State
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const config = { configurable: { thread_id: threadId } };

  if (payload.checkpoint_id) {
    config.configurable.checkpoint_id = payload.checkpoint_id;
  }
  if (payload.checkpoint) {
    Object.assign(config.configurable, payload.checkpoint);
  }

  try {
    const userId = c.get("user")?.displayName;
    if (userId) {
      config.configurable.user_id = userId;
    }
  } catch {}

  const inserted = await Threads.State.post(
    config,
    payload.values,
    payload.as_node
  );

  return c.json(inserted);
});

threads.get("/:thread_id/state/:checkpoint_id", async (c) => {
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

threads.post("/:thread_id/state/checkpoint", async (c) => {
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

threads.get("/:thread_id/history", async (c) => {
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

threads.post("/:thread_id/history", async (c) => {
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

threads.get("/:thread_id", async (c) => {
  // Get Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const thread = await Threads.get(threadId);
  return c.json(thread);
});

threads.delete("/:thread_id", async (c) => {
  // Delete Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  await Threads.delete(threadId);
  return new Response(null, { status: 204 });
});

threads.patch("/:thread_id", async (c) => {
  // Patch Thread
  const threadId = c.req.param("thread_id");
  validateUuid(threadId, "Invalid thread ID: must be a UUID");

  const payload = await c.req.json();
  const thread = await Threads.patch(threadId, {
    metadata: payload.metadata,
  });

  return c.json(thread);
});

threads.post("/:thread_id/copy", async (c) => {
  // Copy Thread
  const threadId = c.req.param("thread_id");
  const thread = await Threads.copy(threadId);
  return c.json(thread);
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

threads.post(
  "/:thread_id/runs/stream",
  zValidator("json", schemas.RunStream),
  async (c) => {
    // Stream Run
    const threadId = c.req.param("thread_id");
    validateUuid(threadId, "Invalid thread ID: must be a UUID");
    const payload = c.req.valid("json");

    throw new HTTPException(500, { message: "Not implemented: Stream Run" });
  }
);

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
