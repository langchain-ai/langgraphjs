import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { v4 as uuid } from "uuid";
import { z } from "zod";

import {
  getAssistantId,
  getCachedStaticGraphSchema,
  getGraph,
} from "../graph/load.mjs";
import { getRuntimeGraphSchema } from "../graph/parser/index.mjs";

import { HTTPException } from "hono/http-exception";
import * as schemas from "../schemas.mjs";
import { assistants } from "../storage/context.mjs";
const api = new Hono();

const RunnableConfigSchema = z.object({
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  run_name: z.string().optional(),
  max_concurrency: z.number().optional(),
  recursion_limit: z.number().optional(),
  configurable: z.record(z.unknown()).optional(),
  run_id: z.string().uuid().optional(),
});

const getRunnableConfig = (
  userConfig: z.infer<typeof RunnableConfigSchema> | null | undefined
) => {
  if (!userConfig) return {};
  return {
    configurable: userConfig.configurable,
    tags: userConfig.tags,
    metadata: userConfig.metadata,
    runName: userConfig.run_name,
    maxConcurrency: userConfig.max_concurrency,
    recursionLimit: userConfig.recursion_limit,
    runId: userConfig.run_id,
  };
};

api.post(
  "/assistants",
  zValidator("json", schemas.AssistantCreate),
  async (c) => {
    // Create Assistant
    const payload = c.req.valid("json");
    const assistant = await assistants().put(
      payload.assistant_id ?? uuid(),
      {
        config: payload.config ?? {},
        context: payload.context ?? {},
        graph_id: payload.graph_id,
        metadata: payload.metadata ?? {},
        if_exists: payload.if_exists ?? "raise",
        name: payload.name ?? "Untitled",
      },
      c.var.auth
    );

    return c.json(assistant);
  }
);

api.post(
  "/assistants/search",
  zValidator("json", schemas.AssistantSearchRequest),
  async (c) => {
    // Search Assistants
    const payload = c.req.valid("json");
    const result: unknown[] = [];

    let total = 0;
    for await (const item of assistants().search(
      {
        graph_id: payload.graph_id,
        metadata: payload.metadata,
        limit: payload.limit ?? 10,
        offset: payload.offset ?? 0,
      },
      c.var.auth
    )) {
      result.push(item.assistant);
      if (total === 0) {
        total = item.total;
      }
    }

    c.res.headers.set("X-Pagination-Total", total.toString());
    return c.json(result);
  }
);

api.get("/assistants/:assistant_id", async (c) => {
  // Get Assistant
  const assistantId = getAssistantId(c.req.param("assistant_id"));
  return c.json(await assistants().get(assistantId, c.var.auth));
});

api.delete("/assistants/:assistant_id", async (c) => {
  // Delete Assistant
  const assistantId = getAssistantId(c.req.param("assistant_id"));
  return c.json(await assistants().delete(assistantId, c.var.auth));
});

api.patch(
  "/assistants/:assistant_id",
  zValidator("json", schemas.AssistantPatch),
  async (c) => {
    // Patch Assistant
    const assistantId = getAssistantId(c.req.param("assistant_id"));
    const payload = c.req.valid("json");

    return c.json(await assistants().patch(assistantId, payload, c.var.auth));
  }
);

api.get(
  "/assistants/:assistant_id/graph",
  zValidator("query", z.object({ xray: schemas.coercedBoolean.optional() })),
  async (c) => {
    // Get Assistant Graph
    const assistantId = getAssistantId(c.req.param("assistant_id"));
    const assistant = await assistants().get(assistantId, c.var.auth);
    const { xray } = c.req.valid("query");

    const config = getRunnableConfig(assistant.config);
    const graph = await getGraph(assistant.graph_id, config);
    const drawable = await graph.getGraphAsync({
      ...config,
      xray: xray ?? undefined,
    });
    return c.json(drawable.toJSON());
  }
);

api.get(
  "/assistants/:assistant_id/schemas",
  zValidator("json", z.object({ config: RunnableConfigSchema.optional() })),
  async (c) => {
    // Get Assistant Schemas
    const json = c.req.valid("json");
    const assistantId = getAssistantId(c.req.param("assistant_id"));
    const assistant = await assistants().get(assistantId, c.var.auth);

    const config = getRunnableConfig(json.config);
    const graph = await getGraph(assistant.graph_id, config);

    const schema = await (async () => {
      const runtimeSchema = await getRuntimeGraphSchema(graph);
      if (runtimeSchema) return runtimeSchema;

      const graphSchema = await getCachedStaticGraphSchema(assistant.graph_id);
      const rootGraphId = Object.keys(graphSchema).find(
        (i) => !i.includes("|")
      );

      if (!rootGraphId)
        throw new HTTPException(404, { message: "Failed to find root graph" });
      return graphSchema[rootGraphId];
    })();

    return c.json({
      graph_id: assistant.graph_id,
      input_schema: schema.input,
      output_schema: schema.output,
      state_schema: schema.state,
      config_schema: schema.config,

      // From JS PoV `configSchema` and `contextSchema` are indistinguishable,
      // thus we use config_schema for context_schema.
      context_schema: schema.config,
    });
  }
);

api.get(
  "/assistants/:assistant_id/subgraphs/:namespace?",
  zValidator(
    "param",
    z.object({ assistant_id: z.string(), namespace: z.string().optional() })
  ),
  zValidator("query", z.object({ recurse: schemas.coercedBoolean.optional() })),
  async (c) => {
    // Get Assistant Subgraphs
    const { assistant_id, namespace } = c.req.valid("param");
    const { recurse } = c.req.valid("query");

    const assistantId = getAssistantId(assistant_id);
    const assistant = await assistants().get(assistantId, c.var.auth);

    const config = getRunnableConfig(assistant.config);
    const graph = await getGraph(assistant.graph_id, config);

    const result: Array<[name: string, schema: Record<string, any>]> = [];
    const subgraphsGenerator =
      "getSubgraphsAsync" in graph
        ? graph.getSubgraphsAsync.bind(graph)
        : // @ts-expect-error older versions of langgraph don't have getSubgraphsAsync
          graph.getSubgraphs.bind(graph);

    let graphSchemaPromise:
      | ReturnType<typeof getCachedStaticGraphSchema>
      | undefined;

    for await (const [ns, subgraph] of subgraphsGenerator(namespace, recurse)) {
      const schema = await (async () => {
        const runtimeSchema = await getRuntimeGraphSchema(subgraph);
        if (runtimeSchema) return runtimeSchema;

        graphSchemaPromise ??= getCachedStaticGraphSchema(assistant.graph_id);
        const graphSchema = await graphSchemaPromise;

        const rootGraphId = Object.keys(graphSchema).find(
          (i) => !i.includes("|")
        );
        if (!rootGraphId) {
          throw new HTTPException(404, {
            message: "Failed to find root graph",
          });
        }

        return graphSchema[`${rootGraphId}|${ns}`] || graphSchema[rootGraphId];
      })();

      result.push([ns, schema]);
    }

    return c.json(Object.fromEntries(result));
  }
);

api.post(
  "/assistants/:assistant_id/latest",
  zValidator("json", schemas.AssistantLatestVersion),
  async (c) => {
    // Set Latest Assistant Version
    const assistantId = getAssistantId(c.req.param("assistant_id"));
    const { version } = c.req.valid("json");
    return c.json(
      await assistants().setLatest(assistantId, version, c.var.auth)
    );
  }
);

api.post(
  "/assistants/:assistant_id/versions",
  zValidator(
    "json",
    z.object({
      limit: z.number().min(1).max(1000).optional().default(10),
      offset: z.number().min(0).optional().default(0),
      metadata: z.record(z.unknown()).optional(),
    })
  ),
  async (c) => {
    // Get Assistant Versions
    const assistantId = getAssistantId(c.req.param("assistant_id"));
    const { limit, offset, metadata } = c.req.valid("json");
    const versions = await assistants().getVersions(
      assistantId,
      { limit, offset, metadata },
      c.var.auth
    );

    if (!versions?.length) {
      throw new HTTPException(404, {
        message: `Assistant "${assistantId}" not found.`,
      });
    }

    return c.json(versions);
  }
);

export default api;
