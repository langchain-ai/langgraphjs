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
import { serialiseAsDict } from "../utils/serde.mjs";
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
  put: (id: string, options: { metadata?: Metadata }) => Promise<void>;
  delete: (id: string) => Promise<void>;
}

function createStubRun(
  threadId: string,
  payload: z.infer<typeof schemas.RunCreate>
): Run {
  const now = new Date();
  const runId = uuidv4();

  const streamMode = Array.isArray(payload.stream_mode)
    ? payload.stream_mode
    : payload.stream_mode
    ? [payload.stream_mode]
    : undefined;

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
    // create a new threaad
    const payload = c.req.valid("json");
    const threadId = payload.thread_id || uuidv4();

    await options.threads.put(threadId, payload);
    return jsonExtra(c, { thread_id: threadId });
  });

  api.get(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    async (c) => {
      // Get Thread
      const { thread_id } = c.req.valid("param");
      const thread = await options.threads.get(thread_id);
      return jsonExtra(c, thread);
    }
  );

  api.delete(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      await options.threads.delete(thread_id);
      return new Response(null, { status: 204 });
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
      return streamSSE(c, async (stream) => {
        const { thread_id } = c.req.valid("param");
        const payload = c.req.valid("json");

        const signal = getDisconnectAbortSignal(c, stream);
        const run = createStubRun(thread_id, payload);

        // update thread with new graph_id
        const thread = await options.threads.get(thread_id);
        await options.threads.put(thread_id, {
          metadata: {
            ...thread.metadata,
            graph_id: payload.assistant_id,
            assistant_id: payload.assistant_id,
          },
        });

        for await (const { event, data } of streamState(run, {
          attempt: 1,
          getGraph,
          signal,
        })) {
          await stream.writeSSE({ data: serialiseAsDict(data), event });
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

      await options.threads.put(threadId, {
        metadata: {
          graph_id: payload.assistant_id,
          assistant_id: payload.assistant_id,
        },
      });

      try {
        const run = createStubRun(threadId, payload);
        for await (const { event, data } of streamState(run, {
          attempt: 1,
          getGraph,
          signal,
        })) {
          await stream.writeSSE({ data: serialiseAsDict(data), event });
        }
      } finally {
        await options.threads.delete(threadId);
      }
    });
  });

  return api;
}
