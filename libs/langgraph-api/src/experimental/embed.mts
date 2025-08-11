import type {
  BaseCheckpointSaver,
  BaseStore,
  Pregel,
} from "@langchain/langgraph";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { RunnableConfig } from "@langchain/core/runnables";
import { v4 as uuidv4 } from "uuid";

import type { Metadata, Run } from "../storage/ops.mjs";
import * as schemas from "../schemas.mjs";

import { z } from "zod";
import { streamState } from "../stream.mjs";
import { serialiseAsDict, serializeError } from "../utils/serde.mjs";
import { getDisconnectAbortSignal, jsonExtra } from "../utils/hono.mjs";
import { stateSnapshotToThreadState } from "../state.mjs";
import { ensureContentType } from "../http/middleware.mjs";

type AnyPregel = Pregel<any, any, any, any, any>;

interface Thread {
  thread_id: string;
  metadata: Metadata;
}

interface ThreadSaver {
  get: (id: string) => Promise<Thread>;

  set: (
    id: string,
    options: { kind: "put" | "patch"; metadata?: Metadata }
  ) => Promise<Thread>;
  delete: (id: string) => Promise<void>;

  search?: (options: {
    metadata?: Metadata;
    limit: number;
    offset: number;
    sortBy: "created_at" | "updated_at";
    sortOrder: "asc" | "desc";
  }) => AsyncGenerator<{ thread: Thread; total: number }>;
}

function createStubRun(
  threadId: string,
  payload: z.infer<typeof schemas.RunCreate>
): Run {
  const now = new Date();
  const runId = uuidv4();

  let streamMode = Array.isArray(payload.stream_mode)
    ? payload.stream_mode
    : payload.stream_mode
    ? [payload.stream_mode]
    : undefined;

  if (streamMode == null || streamMode.length === 0) streamMode = ["values"];
  const config = Object.assign(
    {},
    payload.config ?? {},
    {
      configurable: {
        run_id: runId,
        thread_id: threadId,
        graph_id: payload.assistant_id,
        ...(payload.checkpoint_id
          ? { checkpoint_id: payload.checkpoint_id }
          : null),
        ...payload.checkpoint,
        ...(payload.langsmith_tracer
          ? {
              langsmith_project: payload.langsmith_tracer.project_name,
              langsmith_example_id: payload.langsmith_tracer.example_id,
            }
          : null),
      },
    },
    { metadata: payload.metadata ?? {} }
  );

  return {
    run_id: runId,
    thread_id: threadId,
    assistant_id: payload.assistant_id,
    metadata: payload.metadata ?? {},
    status: "running",
    kwargs: {
      input: payload.input,
      command: payload.command,
      config,
      context: payload.context,
      stream_mode: streamMode,
      interrupt_before: payload.interrupt_before,
      interrupt_after: payload.interrupt_after,
      feedback_keys: payload.feedback_keys,
      subgraphs: payload.stream_subgraphs,
      temporary: false,
    },
    multitask_strategy: "reject",
    created_at: now,
    updated_at: now,
  };
}

/**
 * Attach LangGraph Platform-esque routes to a given Hono instance.
 * @experimental Does not follow semver.
 */
export function createEmbedServer(options: {
  graph: Record<string, AnyPregel>;
  threads: ThreadSaver;
  checkpointer: BaseCheckpointSaver;
  store?: BaseStore;
}) {
  async function getGraph(graphId: string) {
    const targetGraph = options.graph[graphId];
    targetGraph.store = options.store;
    targetGraph.checkpointer = options.checkpointer;
    return targetGraph;
  }

  const api = new Hono();

  api.use(ensureContentType());

  api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
    // create a new thread
    const payload = c.req.valid("json");
    const threadId = payload.thread_id || uuidv4();
    return jsonExtra(
      c,
      await options.threads.set(threadId, {
        kind: "put",
        metadata: payload.metadata,
      })
    );
  });

  api.get(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    async (c) => {
      // Get Thread
      const { thread_id } = c.req.valid("param");
      return jsonExtra(c, await options.threads.get(thread_id));
    }
  );

  api.patch(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    zValidator("json", schemas.ThreadCreate),
    async (c) => {
      // Update Thread
      const { thread_id } = c.req.valid("param");
      const payload = c.req.valid("json");
      return jsonExtra(
        c,
        await options.threads.set(thread_id, {
          kind: "patch",
          metadata: payload.metadata,
        })
      );
    }
  );

  api.delete(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    async (c) => {
      // Delete Thread
      const { thread_id } = c.req.valid("param");
      await options.threads.delete(thread_id);
      return new Response(null, { status: 204 });
    }
  );

  api.post(
    "/threads/search",
    zValidator("json", schemas.ThreadSearchRequest),
    async (c) => {
      const payload = c.req.valid("json");
      const result: unknown[] = [];

      if (!options.threads.search)
        return c.json({ error: "Threads search not implemented" }, 422);

      const sortBy =
        payload.sort_by === "created_at" || payload.sort_by === "updated_at"
          ? payload.sort_by
          : "created_at";

      let total = 0;
      for await (const item of options.threads.search({
        metadata: payload.metadata,
        limit: payload.limit ?? 10,
        offset: payload.offset ?? 0,
        sortBy,
        sortOrder: payload.sort_order ?? "desc",
      })) {
        result.push(item.thread);
        // Only set total if it's the first item
        if (total === 0) total = item.total;
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

      const thread = await options.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await getGraph(graphId) : undefined;

      if (graph == null) {
        return jsonExtra(
          c,
          stateSnapshotToThreadState({
            values: {},
            next: [],
            config: {},
            metadata: undefined,
            createdAt: undefined,
            parentConfig: undefined,
            tasks: [],
          })
        );
      }

      const config = { configurable: { thread_id } };
      const result = await graph.getState(config, { subgraphs });
      return jsonExtra(c, stateSnapshotToThreadState(result));
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
      config.configurable ??= {};

      if (payload.checkpoint_id) {
        config.configurable.checkpoint_id = payload.checkpoint_id;
      }

      if (payload.checkpoint) {
        Object.assign(config.configurable, payload.checkpoint);
      }

      const thread = await options.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await getGraph(graphId) : undefined;
      if (graph == null) return c.json({ error: "Graph not found" }, 404);

      const result = await graph.updateState(
        config,
        payload.values,
        payload.as_node
      );
      return jsonExtra(c, { checkpoint: result.configurable });
    }
  );

  // get thread state at checkpoint
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

      const thread = await options.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await getGraph(graphId) : undefined;
      if (graph == null) return c.json({ error: "Graph not found" }, 404);

      const result = await graph.getState(
        { configurable: { thread_id, checkpoint_id } },
        { subgraphs }
      );
      return jsonExtra(c, stateSnapshotToThreadState(result));
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
      // Get Thread State At Checkpoint post
      const { thread_id } = c.req.valid("param");
      const { checkpoint, subgraphs } = c.req.valid("json");

      const thread = await options.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await getGraph(graphId) : undefined;
      if (graph == null) return c.json({ error: "Graph not found" }, 404);

      const result = await graph.getState(
        { configurable: { thread_id, ...checkpoint } },
        { subgraphs }
      );
      return jsonExtra(c, stateSnapshotToThreadState(result));
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

      const thread = await options.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await getGraph(graphId) : undefined;
      if (graph == null) return jsonExtra(c, []);

      const config = { configurable: { thread_id, ...checkpoint } };

      const result = [];
      const beforeConfig: RunnableConfig | undefined =
        typeof before === "string"
          ? { configurable: { checkpoint_id: before } }
          : before;

      for await (const state of graph.getStateHistory(config, {
        limit,
        before: beforeConfig,
        filter: metadata,
      })) {
        result.push(stateSnapshotToThreadState(state));
      }
      return jsonExtra(c, result);
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

      const thread = await options.threads.get(thread_id);
      if (thread == null) return c.json({ error: "Thread not found" }, 404);

      return streamSSE(c, async (stream) => {
        const signal = getDisconnectAbortSignal(c, stream);
        const run = createStubRun(thread_id, payload);

        await options.threads.set(thread_id, {
          kind: "patch",
          metadata: {
            graph_id: payload.assistant_id,
            assistant_id: payload.assistant_id,
          },
        });

        try {
          for await (const { event, data } of streamState(run, {
            attempt: 1,
            getGraph,
            signal,
          })) {
            await stream.writeSSE({ data: serialiseAsDict(data), event });
          }
        } catch (error) {
          await stream.writeSSE({
            data: serialiseAsDict(serializeError(error)),
            event: "error",
          });
        }
      });
    }
  );

  api.post("/runs/stream", zValidator("json", schemas.RunCreate), async (c) => {
    // Stream Stateless Run
    return streamSSE(c, async (stream) => {
      const payload = c.req.valid("json");
      const signal = getDisconnectAbortSignal(c, stream);
      const threadId = uuidv4();

      await options.threads.set(threadId, {
        kind: "put",
        metadata: {
          graph_id: payload.assistant_id,
          assistant_id: payload.assistant_id,
        },
      });

      try {
        const run = createStubRun(threadId, payload);
        try {
          for await (const { event, data } of streamState(run, {
            attempt: 1,
            getGraph,
            signal,
          })) {
            await stream.writeSSE({ data: serialiseAsDict(data), event });
          }
        } catch (error) {
          await stream.writeSSE({
            data: serialiseAsDict(serializeError(error)),
            event: "error",
          });
        }
      } finally {
        await options.threads.delete(threadId);
      }
    });
  });

  api.notFound((c) => {
    return c.json(
      { error: `${c.req.method} ${c.req.path} not implemented` },
      404
    );
  });

  return api;
}
