import { getGraph, registerFromEnv } from "../src/graph/load.mjs";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";

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

class RemoteCheckpointer extends BaseCheckpointSaver {
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const res = await fetch("http://localhost:9998/get_tuple", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    return res.json();
  }
  async *list(
    config: RunnableConfig,
    limit?: number,
    before?: RunnableConfig
  ): AsyncGenerator<CheckpointTuple> {
    const res = await fetch("http://localhost:9998/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, limit, before }),
    });
    const result: CheckpointTuple[] = await res.json();
    for (const item of result) {
      yield item;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const response = await fetch("http://localhost:9998/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          ...config,
          configurable: {
            ...config.configurable,
            checkpoint_ns: "",
          },
        },
        checkpoint,
        metadata,
      }),
    });

    return response.json();
  }
}

const checkpointer = new RemoteCheckpointer();

async function main() {
  await registerFromEnv();

  const app = new Hono();
  app.post(
    "/:graphId/streamEvents",
    zValidator(
      "json",
      z.object({
        input: z.unknown(),
        config: RunnableConfigSchema.nullish(),
      })
    ),
    async (c) => {
      const graphId = c.req.param("graphId");
      const graph = getGraph(graphId, { checkpointer });

      const payload = c.req.valid("json");

      return streamSSE(c, async (stream) => {
        for await (const item of graph.streamEvents(payload.input, {
          ...getRunnableConfig(payload.config),
          version: "v2",
        })) {
          await stream.writeSSE({
            data: JSON.stringify(item),
            event: "streamLog",
          });
        }
      });
    }
  );

  app.post("/:graphId/getGraph", async (c) => {
    const graphId = c.req.param("graphId");
    const graph = getGraph(graphId, { checkpointer });
    return c.json(graph.getGraph().toJSON());
  });

  app.post(
    "/:graphId/getState",
    zValidator("json", z.object({ config: RunnableConfigSchema })),
    async (c) => {
      const graphId = c.req.param("graphId");
      const graph = getGraph(graphId, { checkpointer });
      const payload = c.req.valid("json");

      const state = await graph.getState(getRunnableConfig(payload.config));
      return c.json(state);
    }
  );

  app.post(
    "/:graphId/updateState",
    zValidator(
      "json",
      z.object({
        config: RunnableConfigSchema,
        values: z.unknown(),
        as_node: z.string().optional(),
      })
    ),
    async (c) => {
      const graphId = c.req.param("graphId");
      const graph = getGraph(graphId, { checkpointer });
      const payload = c.req.valid("json");

      const config = await graph.updateState(
        getRunnableConfig(payload.config),
        payload.values,
        payload.as_node
      );

      return c.json(config);
    }
  );

  app.post(
    "/:graphId/getStateHistory",
    zValidator(
      "json",
      z.object({
        config: RunnableConfigSchema,
        limit: z.number().optional(),
        before: RunnableConfigSchema.optional(),
      })
    ),
    async (c) => {
      const graphId = c.req.param("graphId");
      const graph = getGraph(graphId, { checkpointer });
      const payload = c.req.valid("json");

      return streamSSE(c, async (stream) => {
        for await (const item of graph.getStateHistory(
          getRunnableConfig(payload.config),
          payload.limit,
          getRunnableConfig(payload.before)
        )) {
          await stream.writeSSE({
            data: JSON.stringify(item),
            event: "getStateHistory",
          });
        }
      });
    }
  );

  serve({ fetch: app.fetch, port: 9999 }, (c) => {
    console.info(`Listening to ${c.address}:${c.port}`);
  });
}

main();

// graph.astream_events

// graph.get_input_schema
// graph.get_output_schema
// graph.config_schema
// method for getting state schema

// graph.get_graph
// graph.get_state
// grpah.update_state
// graph.get_state_history
// checkpointers
