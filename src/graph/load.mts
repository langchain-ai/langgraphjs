import { z } from "zod";
import * as uuid from "uuid";
import { Assistants } from "../storage/ops.mjs";
import {
  type BaseCheckpointSaver,
  type BaseStore,
  type CompiledGraph,
  InMemoryStore,
  MemorySaver,
} from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import {
  GraphSchema,
  GraphSpec,
  resolveGraph,
  runGraphSchemaWorker,
} from "./load.utils.mjs";

export const GRAPHS: Record<string, CompiledGraph<string>> = {};
export const GRAPH_SPEC: Record<string, GraphSpec> = {};
export const GRAPH_SCHEMA: Record<string, Record<string, GraphSchema>> = {};

export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8"
);

const SpecSchema = z.record(z.string());
const ConfigSchema = z.record(z.unknown());

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      LANGSERVE_GRAPHS: string;
      LANGGRAPH_CONFIG: string | undefined;
      PORT: string;
    }
  }
}

export async function registerFromEnv() {
  const specs = SpecSchema.parse(JSON.parse(process.env.LANGSERVE_GRAPHS));
  const envConfig = process.env.LANGGRAPH_CONFIG
    ? ConfigSchema.parse(JSON.parse(process.env.LANGGRAPH_CONFIG))
    : undefined;

  await Promise.all(
    Object.entries(specs).map(async ([graphId, rawSpec]) => {
      const config = envConfig?.[graphId];
      const { resolved, ...spec } = await resolveGraph(rawSpec);

      // registering the graph runtime
      GRAPHS[graphId] = resolved;
      GRAPH_SPEC[graphId] = spec;

      await Assistants.put(uuid.v5(graphId, NAMESPACE_GRAPH), {
        graph_id: graphId,
        metadata: { created_by: "system" },
        config: config ?? {},
        if_exists: "do_nothing",
      });
    })
  );
}

export function getGraph(
  graphId: string,
  options?: {
    checkpointer?: BaseCheckpointSaver;
    store?: BaseStore;
  }
) {
  if (!GRAPHS[graphId])
    throw new HTTPException(404, { message: `Graph "${graphId}" not found` });

  const compiled = GRAPHS[graphId];
  compiled.checkpointer = options?.checkpointer ?? new MemorySaver();
  compiled.store = options?.store ?? new InMemoryStore();

  return compiled;
}

export async function getGraphSchema(graphId: string) {
  if (!GRAPH_SPEC[graphId])
    throw new HTTPException(404, {
      message: `Spec for "${graphId}" not found`,
    });

  if (!GRAPH_SCHEMA[graphId] || true) {
    try {
      GRAPH_SCHEMA[graphId] = await runGraphSchemaWorker(GRAPH_SPEC[graphId]);
    } catch (error) {
      throw new Error(`Failed to extract schema for "${graphId}": ${error}`);
    }
  }

  return GRAPH_SCHEMA[graphId];
}
