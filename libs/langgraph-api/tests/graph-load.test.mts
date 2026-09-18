import { fileURLToPath } from "node:url";
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerRuntime } from "../src/graph/api.mjs";
import { gatherIterator } from "./utils.mjs";
import { getGraph, GRAPHS } from "../src/graph/load.mjs";
import { resolveGraph } from "../src/graph/load.utils.mjs";
import { streamState } from "../src/stream.mjs";
import { PROTOCOL_STREAM_RUN_KEY } from "../src/protocol/constants.mjs";
import type { Run } from "../src/storage/types.mjs";

const graphId = "factory-config-test";
const cwd = fileURLToPath(new URL("./graphs", import.meta.url));

beforeEach(async () => {
  GRAPHS[graphId] = (
    await resolveGraph("./factory_config.mts:graph", { cwd })
  ).resolved;
});
afterEach(() => {
  delete GRAPHS[graphId];
});

describe("graph factory runtime", () => {
  it("passes context through the resolved factory without changing config", async () => {
    const config = { configurable: { legacy: "kept" } };
    const context = { tenant: "current" };
    const graph = await getGraph(graphId, config, {
      checkpointer: null,
      accessContext: "threads.create_run",
      context,
    });
    expect(await graph.invoke({}, { context })).toMatchObject({
      factoryContext: context,
      nodeContext: context,
      legacy: "kept",
    });
    expect(config).toEqual({ configurable: { legacy: "kept" } });
  });

  it.each(["assistants.read", "threads.read", "threads.update"] as const)(
    "does not provide run context for %s",
    async (accessContext) => {
      const graph = await getGraph(
        graphId,
        {
          context: { reject: true },
          ...{ accessContext: "threads.create_run" },
        },
        {
          checkpointer: null,
          accessContext,
          context: { reject: true },
        }
      );
      expect(await graph.invoke({})).toMatchObject({
        factoryContext: null,
        accessContext,
      });
    }
  );

  it("treats an absent context as execution", async () => {
    const graph = await getGraph(graphId, undefined, {
      checkpointer: null,
      accessContext: "threads.create_run",
    });
    expect(await graph.invoke({})).toMatchObject({
      accessContext: "threads.create_run",
      factoryContext: null,
    });
  });

  it("defaults direct graph loads to inspection", async () => {
    const graph = await getGraph(graphId, undefined, { checkpointer: null });
    expect(await graph.invoke({})).toMatchObject({
      accessContext: "assistants.read",
      factoryContext: null,
    });
  });

  it("continues to load factories that accept only config", async () => {
    GRAPHS[graphId] = (
      await resolveGraph("./dynamic.mts:graph", { cwd })
    ).resolved;
    const graph = await getGraph(
      graphId,
      { configurable: { nodeName: "legacy" } },
      { checkpointer: null }
    );
    expect(await graph.invoke({})).toMatchObject({ node: "legacy" });
  });

  it.each([false, true])(
    "passes current context before streaming (protocol v2: %s)",
    async (protocolV2) => {
      const contexts: Array<{
        accessContext: ServerRuntime["accessContext"] | undefined;
        context: unknown;
      }> = [];
      const checkpointer = new MemorySaver();
      const run = {
        run_id: "00000000-0000-7000-8000-000000000001",
        thread_id: "00000000-0000-7000-8000-000000000002",
        assistant_id: graphId,
        created_at: new Date("2026-04-01T00:00:00Z"),
        updated_at: new Date("2026-04-01T00:00:00Z"),
        status: "running",
        metadata: {},
        multitask_strategy: "interrupt",
        kwargs: {
          input: {},
          context: { tenant: "run" },
          config: {
            configurable: { graph_id: graphId, thread_id: "factory-stream" },
          },
          stream_mode: ["values"],
          ...(protocolV2 ? { [PROTOCOL_STREAM_RUN_KEY]: true } : {}),
        },
      } satisfies Run;
      for (const attempt of [1, 2]) {
        await gatherIterator(
          streamState(run, {
            attempt,
            getGraph: async (id, config, options) => {
              contexts.push({
                accessContext: options?.accessContext,
                context: options?.context,
              });
              return getGraph(id, config, { ...options, checkpointer });
            },
          })
        );
      }
      expect(contexts).toEqual(
        [1, 2].map(() => ({
          accessContext: "threads.create_run",
          context: run.kwargs.context,
        }))
      );
      const graph = await getGraph(graphId, undefined, {
        checkpointer,
        accessContext: "threads.read",
      });
      expect(
        (
          await graph.getState({
            configurable: { thread_id: "factory-stream" },
          })
        ).values
      ).toMatchObject({
        factoryContext: run.kwargs.context,
        nodeContext: run.kwargs.context,
      });
    }
  );
});
