import { BaseCheckpointSaver, BaseStore, Pregel } from "@langchain/langgraph";
import { Hono } from "hono";
import { ensureContentType } from "./http/middleware.mjs";

import * as schemas from "./schemas.mjs";

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import type { Metadata, Run } from "./storage/ops.mjs";
import { streamState } from "./stream.mjs";
import { serialiseAsDict } from "./utils/serde.mjs";
import { jsonExtra } from "./utils/hono.mjs";
import { stateSnapshotToThreadState } from "./state.mjs";
import { RunnableConfig } from "@langchain/core/runnables";
import { v4 as uuidv4 } from "uuid";

type AnyPregel = Pregel<any, any, any, any, any>;

type SimpleThread = {
  thread_id: string;
  metadata: Metadata;
};

export function createServer(app: {
  graph: Record<string, AnyPregel>;
  store?: BaseStore;
  checkpointer: BaseCheckpointSaver;
  threads: {
    get: (threadId: string) => Promise<SimpleThread>;
    put: (threadId: string, options: { metadata?: Metadata }) => Promise<void>;
  };
}) {
  const api = new Hono();
  api.use(ensureContentType());

  api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
    // create a new threaad
    const payload = c.req.valid("json");
    const threadId = payload.thread_id || uuidv4();

    await app.threads.put(threadId, payload);
    return jsonExtra(c, { thread_id: threadId });
  });

  api.get(
    "/threads/:thread_id/state",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({ subgraphs: schemas.coercedBoolean.optional() }),
    ),
    async (c) => {
      // Get Latest Thread State
      const { thread_id } = c.req.valid("param");
      const { subgraphs } = c.req.valid("query");

      const thread = await app.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? app.graph[graphId] : undefined;

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
          }),
        );
      }

      const config = { configurable: { thread_id } };
      const result = await graph.getState(config, { subgraphs });
      return jsonExtra(c, stateSnapshotToThreadState(result));
    },
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
            checkpoint_id: z.string().uuid().optional(),
            checkpoint_ns: z.string().optional(),
            checkpoint_map: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const { limit, before, metadata, checkpoint } = c.req.valid("json");

      const thread = await app.threads.get(thread_id);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? app.graph[graphId] : undefined;
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
    },
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

        const runId = uuidv4();
        const run: Run = {
          run_id: runId,
          thread_id: thread_id,
          assistant_id: payload.assistant_id,
          metadata: payload.metadata ?? {},
          status: "running",
          kwargs: {
            input: payload.input,
            command: payload.command,
            config: Object.assign(
              {},
              payload.config ?? {},
              {
                configurable: {
                  run_id: runId,
                  thread_id,
                  graph_id: payload.assistant_id,
                },
              },
              { metadata: payload.metadata ?? {} },
            ),
            stream_mode: Array.isArray(payload.stream_mode)
              ? payload.stream_mode
              : payload.stream_mode
                ? [payload.stream_mode]
                : undefined,
            interrupt_before: payload.interrupt_before,
            interrupt_after: payload.interrupt_after,
            webhook: payload.webhook,
            feedback_keys: payload.feedback_keys,
            temporary: false,
            subgraphs: false,
            resumable: false,
          },
          multitask_strategy: "reject",
          created_at: new Date(),
          updated_at: new Date(),
        };

        for await (const { event, data } of streamState(run, 1, {
          getGraph: async (graphId) => {
            const targetGraph = app.graph[graphId];

            targetGraph.store = app.store;
            targetGraph.checkpointer = app.checkpointer;

            return targetGraph;
          },
        })) {
          await stream.writeSSE({
            data: serialiseAsDict(data),
            event,
          });
        }
      });
    },
  );

  return api;
}
