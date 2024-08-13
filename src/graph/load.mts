import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as uuid from "uuid";
import { assistants } from "../storage/index.mts";
import {
  BaseCheckpointSaver,
  type CompiledGraph,
  MemorySaver,
} from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";

export const GRAPHS: Record<string, CompiledGraph<string>> = {};
export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8"
);

const SpecSchema = z.record(z.string());

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      LANGSERVE_GRAPHS: string;
      PORT: string;
    }
  }
}

export async function registerFromEnv() {
  const specs = SpecSchema.parse(JSON.parse(process.env.LANGSERVE_GRAPHS));
  await Promise.all(
    Object.entries(specs).map(async ([graphId, spec]) => {
      const [userFile, exportSymbol] = spec.split(":", 2);

      // validate file exists
      await fs.stat(userFile);

      const sourceFile = path.resolve(process.cwd(), userFile);
      const graph = await import(sourceFile).then(
        (module) => module[exportSymbol || "default"]
      );
      if (!graph) throw new Error("Failed to load the graph");

      console.debug("Loading graph", graphId, "from", sourceFile);

      // registering the graph runtime
      GRAPHS[graphId] = graph;

      await assistants.put(uuid.v5(graphId, NAMESPACE_GRAPH), {
        graphId,
        metadata: { created_by: "system" },
        config: {},
        ifExists: "do_nothing",
      });
    })
  );
}

export function getGraph(
  graphId: string,
  options?: {
    checkpointer?: BaseCheckpointSaver;
  }
) {
  if (!GRAPHS[graphId]) {
    throw new HTTPException(404, { message: `Graph "${graphId}" not found` });
  }

  // TODO: support graph factory
  // TODO: inject the checkpointer
  // TODO: load the state schema

  // GRAPHS[graphId].
  const compiled = GRAPHS[graphId];
  compiled.checkpointer = options?.checkpointer ?? new MemorySaver();
  return compiled;
}
