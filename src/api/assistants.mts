import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { v4 as uuid } from "uuid";
import { LangGraphRunnableConfig } from "../storage/ops.mjs";
import { z } from "zod";

import { getGraph, getGraphSchema } from "../graph/load.mjs";
import { validateUuid } from "../utils/uuid.mjs";

import { Assistants } from "../storage/ops.mjs";
import * as schemas from "../schemas.mjs";

const api = new Hono();

api.post(
  "/assistants",
  zValidator("json", schemas.AssistantCreate),
  async (c) => {
    // Create Assistant
    const payload = c.req.valid("json");
    const assistant = await Assistants.put(payload.assistant_id ?? uuid(), {
      config: payload.config as LangGraphRunnableConfig,
      graph_id: payload.graph_id,
      metadata: payload.metadata ?? {},
      if_exists: payload.if_exists ?? "raise",
      name: payload.name ?? "Untitled",
    });

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

    for await (const item of Assistants.search({
      graph_id: payload.graph_id,
      metadata: payload.metadata,
      limit: payload.limit ?? 10,
      offset: payload.offset ?? 0,
    })) {
      result.push(item);
    }

    return c.json(result);
  }
);

api.get("/assistants/:assistant_id", async (c) => {
  // Get Assistant
  const assistantId = validateUuid(c.req.param("assistant_id"));
  return c.json(await Assistants.get(assistantId));
});

api.delete("/assistants/:assistant_id", async (c) => {
  // Delete Assistant
  const assistantId = validateUuid(c.req.param("assistant_id"));
  return c.json(await Assistants.delete(assistantId));
});

api.patch(
  "/assistants/:assistant_id",
  zValidator("json", schemas.AssistantPatch),
  async (c) => {
    // Patch Assistant
    const assistantId = validateUuid(c.req.param("assistant_id"));
    const payload = c.req.valid("json");

    return c.json(await Assistants.patch(assistantId, payload));
  }
);

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

api.get("/assistants/:assistant_id/graph", async (c) => {
  // Get Assistant Graph
  const assistantId = validateUuid(c.req.param("assistant_id"));
  const assistant = await Assistants.get(assistantId);

  const xray = c.req.query("xray") === "true";

  const graph = getGraph(assistant.graph_id);
  return c.json(
    graph.getGraph({ ...getRunnableConfig(assistant.config), xray }).toJSON()
  );
});

api.get("/assistants/:assistant_id/schemas", async (c) => {
  // Get Assistant Schemas
  const assistantId = validateUuid(c.req.param("assistant_id"));
  const assistant = await Assistants.get(assistantId);
  const graph = getGraph(assistant.graph_id);

  // TODO: add support for input/output/state/config schema

  const graphSchema = await getGraphSchema(assistant.graph_id);
  const rootGraphId = Object.keys(graphSchema).find((i) => !i.includes("|"));

  if (!rootGraphId) throw new Error("Failed to find root graph");
  const rootGraphSchema = graphSchema[rootGraphId];

  return c.json({
    graph_id: assistant.graph_id,
    input_schema: rootGraphSchema.input,
    output_schema: rootGraphSchema.output,
    state_schema: rootGraphSchema.state,
    config_schema: rootGraphSchema.config,
  });
});

api.get("/assistants/:assistant_id/subgraphs", async (c) => {
  // Get Assistant Subgraphs
  const assistantId = validateUuid(c.req.param("assistant_id"));
  const assistant = await Assistants.get(assistantId);
  const graph = getGraph(assistant.graph_id);

  // TODO: implement subgraphs retrieval
  const recurse = c.req.query("recurse") === "true";
  const namespace = c.req.query("namespace");

  return c.json({
    subgraphs: {}, // TODO: implement
  });
});

api.get("/assistants/:assistant_id/versions", async (c) => {
  // Get Assistant Versions
  const assistantId = validateUuid(c.req.param("assistant_id"));

  // TODO: implement version retrieval
  return c.json({
    versions: [],
  });
});

api.post(
  "/assistants/:assistant_id/latest",
  zValidator("json", schemas.AssistantLatestVersion),
  async (c) => {
    // Set Latest Assistant Version
    const assistantId = validateUuid(c.req.param("assistant_id"));
    const payload = c.req.valid("json");

    // TODO: implement version update
    return c.json({
      // Return updated assistant
    });
  }
);

export default api;
