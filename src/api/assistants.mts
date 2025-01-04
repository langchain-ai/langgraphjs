import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { v4 as uuid } from "uuid";
import { Config } from "../storage/base.mts";
import { z } from "zod";

import { getGraph } from "../graph.mts";
import { validateUuid } from "../utils/uuid.mts";

import * as storage from "../storage/index.mts";
import * as schemas from "../validate.mts";

export const assistants = new Hono();

assistants.post("/", zValidator("json", schemas.AssistantCreate), async (c) => {
  // Create Assistant
  const payload = c.req.valid("json");
  const assistant = await storage.assistants.put(
    payload.assistant_id ?? uuid(),
    {
      config: payload.config as Config,
      graphId: payload.graph_id,
      metadata: payload.metadata ?? {},
      ifExists: payload.if_exists ?? "raise",
    }
  );

  return c.json(assistant);
});

assistants.post(
  "/search",
  zValidator("json", schemas.AssistantSearchRequest),
  async (c) => {
    // Search Assistants
    const payload = c.req.valid("json");
    const result: z.infer<(typeof schemas)["Assistant"]>[] = [];

    for await (const item of storage.assistants.search({
      limit: payload.limit,
      offset: payload.offset,
      metadata: payload.metadata,
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

assistants.get("/:assistant_id", async (c) => {
  // Get Assistant
  const assistantId = validateUuid(c.req.param("assistant_id"));
  return c.json(await storage.assistants.get(assistantId));
});

assistants.delete("/:assistant_id", async (c) => {
  // Delete Assistant
  const assistantId = validateUuid(c.req.param("assistant_id"));
  return c.json(await storage.assistants.delete(assistantId));
});

assistants.patch(
  "/:assistant_id",
  zValidator("json", schemas.AssistantPatch),
  async (c) => {
    // Patch Assistant
    const assistantId = validateUuid(c.req.param("assistant_id"));
    const payload = c.req.valid("json");

    return c.json(await storage.assistants.patch(assistantId, payload));
  }
);

assistants.get("/:assistant_id/graph", async (c) => {
  // Get Assistant Graph
  const assistantId = validateUuid(c.req.param("assistant_id"));
  const assistant = await storage.assistants.get(assistantId);
  return c.json(getGraph(assistant.graph_id).getGraph().toJSON());
});

assistants.get("/:assistant_id/schemas", async (c) => {
  // Get Assistant Schemas
  const assistantId = validateUuid(c.req.param("assistant_id"));
  const assistant = await storage.assistants.get(assistantId);
  const graph = getGraph(assistant.graph_id);

  // TODO: add support for input/output/state/config schema

  return c.json({
    graph_id: assistant.graph_id,
    input_schema: null,
    output_schema: null,
    state_schema: null,
    config_schema: null,
  });
});
