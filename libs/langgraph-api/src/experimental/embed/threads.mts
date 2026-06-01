import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod/v3";
import { RunnableConfig } from "@langchain/core/runnables";

import * as schemas from "../../schemas.mjs";
import { jsonExtra } from "../../utils/hono.mjs";
import { stateSnapshotToThreadState } from "../../state.mjs";

import type { EmbedRouteContext } from "./types.mjs";

/**
 * Register thread CRUD and state routes on an embed server Hono app.
 *
 * @experimental Does not follow semver.
 */
export function registerThreadRoutes(api: Hono, context: EmbedRouteContext) {
  api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
    const payload = c.req.valid("json");
    const threadId = payload.thread_id || uuidv7();
    return jsonExtra(
      c,
      await context.threads.set(threadId, {
        kind: "put",
        metadata: payload.metadata,
      })
    );
  });

  api.get(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      return jsonExtra(c, await context.threads.get(thread_id));
    }
  );

  api.patch(
    "/threads/:thread_id",
    zValidator("param", z.object({ thread_id: z.string().uuid() })),
    zValidator("json", schemas.ThreadCreate),
    async (c) => {
      const { thread_id } = c.req.valid("param");
      const payload = c.req.valid("json");
      return jsonExtra(
        c,
        await context.threads.set(thread_id, {
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
      const { thread_id } = c.req.valid("param");
      await context.threads.delete(thread_id);
      return new Response(null, { status: 204 });
    }
  );

  api.post(
    "/threads/search",
    zValidator("json", schemas.ThreadSearchRequest),
    async (c) => {
      const payload = c.req.valid("json");
      const result: unknown[] = [];

      if (!context.threads.search)
        return c.json({ error: "Threads search not implemented" }, 422);

      const sortBy =
        payload.sort_by === "created_at" || payload.sort_by === "updated_at"
          ? payload.sort_by
          : "created_at";

      let total = 0;
      for await (const item of context.threads.search({
        metadata: payload.metadata,
        limit: payload.limit ?? 10,
        offset: payload.offset ?? 0,
        sortBy,
        sortOrder: payload.sort_order ?? "desc",
      })) {
        result.push(item.thread);
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
      const { thread_id } = c.req.valid("param");
      const { subgraphs } = c.req.valid("query");

      const thread = await context.threads.get(thread_id);
      const graphId = thread?.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await context.getGraph(graphId) : undefined;

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

      const thread = await context.threads.get(thread_id);
      const graphId = thread?.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await context.getGraph(graphId) : undefined;
      if (graph == null) return c.json({ error: "Graph not found" }, 404);

      const result = await graph.updateState(
        config,
        payload.values,
        payload.as_node
      );
      return jsonExtra(c, { checkpoint: result.configurable });
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
      const { thread_id, checkpoint_id } = c.req.valid("param");
      const { subgraphs } = c.req.valid("query");

      const thread = await context.threads.get(thread_id);
      const graphId = thread?.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await context.getGraph(graphId) : undefined;
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
      const { thread_id } = c.req.valid("param");
      const { checkpoint, subgraphs } = c.req.valid("json");

      const thread = await context.threads.get(thread_id);
      const graphId = thread?.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await context.getGraph(graphId) : undefined;
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
      const { thread_id } = c.req.valid("param");
      const { limit, before, metadata, checkpoint } = c.req.valid("json");

      const thread = await context.threads.get(thread_id);
      const graphId = thread?.metadata?.graph_id as string | undefined | null;
      const graph = graphId ? await context.getGraph(graphId) : undefined;
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
}
