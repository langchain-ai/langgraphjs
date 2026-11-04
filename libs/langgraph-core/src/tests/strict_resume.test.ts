import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import {
  Command,
  CONFIG_KEY_STRICT_RESUME,
  INTERRUPT,
  START,
} from "../constants.js";
import { UnknownInterruptError } from "../errors.js";
import { interrupt } from "../interrupt.js";
import type { StateSnapshot } from "../pregel/types.js";
import { gatherIterator } from "../utils.js";
import { XXH3 } from "../hash.js";

const UNKNOWN_ID = "0".repeat(32);

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

function config(strict = true) {
  return {
    configurable: { thread_id: "1", [CONFIG_KEY_STRICT_RESUME]: strict },
  };
}

function parallel(checkpointer = new MemorySaver()) {
  return new StateGraph(State)
    .addNode("a", () => ({ log: [`a:${interrupt("a?")}`] }))
    .addNode("b", () => ({ log: [`b:${interrupt("b?")}`] }))
    .addEdge(START, "a")
    .addEdge(START, "b")
    .compile({ checkpointer });
}

function askTwice(checkpointer = new MemorySaver()) {
  return new StateGraph(State)
    .addNode("ask", () => {
      const first = interrupt("first?");
      const second = interrupt("second?");
      return { log: [`${first},${second}`] };
    })
    .addEdge(START, "ask")
    .compile({ checkpointer });
}

async function pendingIds(
  graph: { getState(cfg: RunnableConfig): Promise<StateSnapshot> },
  cfg: RunnableConfig
): Promise<Record<string, string>> {
  const state = await graph.getState(cfg);
  return Object.fromEntries(
    state.tasks.flatMap((t) => t.interrupts).map((i) => [i.value, i.id])
  );
}

describe("strict resume", () => {
  it.each(["sync", "async", "exit"] as const)(
    "refuses an unknown id before anything is written (durability: %s)",
    async (durability) => {
      const checkpointer = new MemorySaver();
      const graph = parallel(checkpointer);
      const cfg = { ...config(), durability };
      await graph.invoke({ log: [] }, cfg);
      const before = await graph.getState(cfg);
      const checkpoints = (await gatherIterator(checkpointer.list(cfg)))
        .length;
      const ids = await pendingIds(graph, cfg);

      await expect(
        graph.invoke(new Command({ resume: { [UNKNOWN_ID]: "x" } }), cfg)
      ).rejects.toMatchObject({
        name: "UnknownInterruptError",
        message: `Unknown or already-consumed interrupt: ${UNKNOWN_ID}`,
        reason: "not_pending",
        interruptIds: [UNKNOWN_ID],
        pendingIds: Object.values(ids).sort(),
      });

      const after = await graph.getState(cfg);
      expect((await gatherIterator(checkpointer.list(cfg))).length).toBe(
        checkpoints
      );
      expect([after.values, after.next, after.tasks]).toEqual([
        before.values,
        before.next,
        before.tasks,
      ]);
      const result = await graph.invoke(
        new Command({ resume: { [ids["a?"]]: "yes", [ids["b?"]]: "no" } }),
        cfg
      );
      expect([...result.log].sort()).toEqual(["a:yes", "b:no"]);
    }
  );

  it("refuses an answered id", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config());
    const ids = await pendingIds(graph, config());
    await graph.invoke(new Command({ resume: { [ids["a?"]]: "yes" } }), config());

    await expect(
      graph.invoke(new Command({ resume: { [ids["a?"]]: "again" } }), config())
    ).rejects.toMatchObject({
      name: "UnknownInterruptError",
      reason: "not_pending",
      interruptIds: [ids["a?"]],
      pendingIds: [ids["b?"]],
    });

    const result = await graph.invoke(
      new Command({ resume: { [ids["b?"]]: "no" } }),
      config()
    );
    expect([...result.log].sort()).toEqual(["a:yes", "b:no"]);
  });

  it("refuses an empty map", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config());
    const ids = await pendingIds(graph, config());

    await expect(
      graph.invoke(new Command({ resume: {} }), config())
    ).rejects.toMatchObject({
      message: "The resume map names no interrupt",
      reason: "empty_map",
      interruptIds: [],
      pendingIds: Object.values(ids).sort(),
    });
  });

  it("refuses one value while several interrupts are pending", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config());

    const ids = await pendingIds(graph, config());
    await expect(
      graph.invoke(new Command({ resume: "yes" }), config())
    ).rejects.toMatchObject({
      message: expect.stringContaining("multiple pending interrupts"),
      reason: "ambiguous",
      pendingIds: Object.values(ids).sort(),
    });

    await graph.invoke(new Command({ resume: { [ids["a?"]]: "yes" } }), config());
    const result = await graph.invoke(new Command({ resume: "no" }), config());
    expect([...result.log].sort()).toEqual(["a:yes", "b:no"]);
  });

  it("changes nothing without the key", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config(false));

    await graph.invoke(
      new Command({ resume: { [UNKNOWN_ID]: "x" } }),
      config(false)
    );
    expect(Object.keys(await pendingIds(graph, config(false))).sort()).toEqual([
      "a?",
      "b?",
    ]);
    const result = await graph.invoke(
      new Command({ resume: "yes" }),
      config(false)
    );
    expect([...result.log].sort()).toEqual(["a:yes", "b:yes"]);
  });

  it("accepts each of a subgraph's parallel interrupts by its id", async () => {
    const subgraph = new StateGraph(State)
      .addNode("qa", () => ({ log: [`qa:${interrupt("qa?")}`] }))
      .addNode("qb", () => ({ log: [`qb:${interrupt("qb?")}`] }))
      .addEdge(START, "qa")
      .addEdge(START, "qb")
      .compile();
    const graph = new StateGraph(State)
      .addNode("sub", subgraph)
      .addEdge(START, "sub")
      .compile({ checkpointer: new MemorySaver() });
    await graph.invoke({ log: [] }, config());

    const ids = await pendingIds(graph, config());
    expect(Object.keys(ids).sort()).toEqual(["qa?", "qb?"]);
    const result = await graph.invoke(
      new Command({ resume: { [ids["qa?"]]: "yes", [ids["qb?"]]: "no" } }),
      config()
    );
    expect([...result.log].sort()).toEqual(["qa:yes", "qb:no"]);
  });

  it("gives a second interrupt in one node its own id", async () => {
    const graph = askTwice();
    await graph.invoke({ log: [] }, config());
    const [task] = (await graph.getState(config())).tasks;
    const card = task.interrupts[0];
    expect(card.id).toBe(XXH3(`ask:${task.id}`));
    await graph.invoke(new Command({ resume: { [card.id!]: "1" } }), config());
    const second = (await graph.getState(config())).tasks[0].interrupts[0];
    expect(second.id).not.toBe(card.id);

    const result = await graph.invoke(
      new Command({ resume: { [second.id!]: "2" } }),
      config()
    );
    expect(result.log).toEqual(["1,2"]);
  });

  it("refuses an answer retried in one node", async () => {
    const graph = askTwice();
    await graph.invoke({ log: [] }, config());
    const card = (await graph.getState(config())).tasks[0].interrupts[0];
    await graph.invoke(new Command({ resume: { [card.id!]: "yes" } }), config());
    const second = (await graph.getState(config())).tasks[0].interrupts[0];

    await expect(
      graph.invoke(new Command({ resume: { [card.id!]: "yes" } }), config())
    ).rejects.toMatchObject({
      reason: "not_pending",
      interruptIds: [card.id],
      pendingIds: [second.id],
    });
    const result = await graph.invoke(
      new Command({ resume: { [second.id!]: "no" } }),
      config()
    );
    expect(result.log).toEqual(["yes,no"]);
  });

  it("gives each of a node's parallel interrupts an answer", async () => {
    const graph = new StateGraph(State)
      .addNode("ask", async () => {
        const b = (async () => interrupt("b?"))();
        b.catch(() => undefined);
        const a = await (async () => interrupt("a?"))();
        return { log: [`${a},${await b}`] };
      })
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });
    await graph.invoke({ log: [] }, config());
    for (const answer of ["1", "2"]) {
      const card = (await graph.getState(config())).tasks[0].interrupts[0];
      await graph.invoke(
        new Command({ resume: { [card.id!]: answer } }),
        config()
      );
    }

    expect((await graph.getState(config())).next).toEqual([]);
  });

  it("still answers a later interrupt saved with the first id", async () => {
    const checkpointer = new MemorySaver();
    const graph = askTwice(checkpointer);
    await graph.invoke({ log: [] }, config());
    const card = (await graph.getState(config())).tasks[0].interrupts[0];
    await graph.invoke(new Command({ resume: { [card.id!]: "1" } }), config());
    const state = await graph.getState(config());
    await checkpointer.putWrites(
      state.config,
      [[INTERRUPT, [{ id: card.id, value: "second?" }]]],
      state.tasks[0].id
    );

    const result = await graph.invoke(
      new Command({ resume: { [card.id!]: "2" } }),
      config()
    );
    expect(result.log).toEqual(["1,2"]);
  });

  it("doesn't refuse a card whose resumed task raised", async () => {
    let failures = 1;
    const graph = new StateGraph(State)
      .addNode("ask", () => {
        const answer = interrupt("approve?");
        if (failures > 0) {
          failures -= 1;
          throw new Error("failed after the answer");
        }
        return { log: [`answered:${answer}`] };
      })
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });
    await graph.invoke({ log: [] }, config());
    const card = (await graph.getState(config())).tasks[0].interrupts[0];
    await expect(
      graph.invoke(new Command({ resume: { [card.id!]: "first" } }), config())
    ).rejects.toThrow("failed after the answer");

    await graph.invoke(
      new Command({ resume: { [card.id!]: "second" } }),
      config()
    );
    expect((await graph.getState(config())).next).toEqual([]);
  });

  it("checks a pinned head checkpoint", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config());
    const head = (await graph.getState(config())).config;
    const pinned = {
      configurable: { ...config().configurable, ...head.configurable },
    };

    await expect(
      graph.invoke(new Command({ resume: { [UNKNOWN_ID]: "x" } }), pinned)
    ).rejects.toThrow(UnknownInterruptError);

    const ids = await pendingIds(graph, config());
    const result = await graph.invoke(
      new Command({ resume: { [ids["a?"]]: "yes", [ids["b?"]]: "no" } }),
      pinned
    );
    expect([...result.log].sort()).toEqual(["a:yes", "b:no"]);
  });

  it("doesn't check a superseded checkpoint", async () => {
    const graph = parallel();
    await graph.invoke({ log: [] }, config());
    const paused = (await graph.getState(config())).config;
    const ids = await pendingIds(graph, config());
    await graph.invoke(
      new Command({ resume: { [ids["a?"]]: "yes", [ids["b?"]]: "no" } }),
      config()
    );

    const pinned = {
      configurable: { ...config().configurable, ...paused.configurable },
    };
    await graph.invoke(
      new Command({ resume: { [ids["a?"]]: "again", [ids["b?"]]: "again" } }),
      pinned
    );
  });

  it("reads an interrupt written by an older version, one per write", async () => {
    const checkpointer = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("ask", () => ({ log: [`asked:${interrupt("ask?")}`] }))
      .addEdge(START, "ask")
      .compile({ checkpointer });
    await graph.invoke({ log: [] }, config());
    const tuple = await checkpointer.getTuple(config());
    const [taskId, , [card]] = tuple!.pendingWrites!.find(
      ([, channel]) => channel === INTERRUPT
    ) as [string, string, { id: string; value: string }[]];
    await checkpointer.putWrites(tuple!.config, [[INTERRUPT, card]], taskId);

    expect(await pendingIds(graph, config())).toEqual({
      "ask?": card.id,
    });
    const result = await graph.invoke(
      new Command({ resume: { [card.id]: "yes" } }),
      config()
    );
    expect(result.log).toEqual(["asked:yes"]);
  });
});

it("passes a falsy resume value to interrupt()", async () => {
  const graph = new StateGraph(State)
    .addNode("ask", () => ({ log: [`answered:${interrupt("ok?")}`] }))
    .addEdge(START, "ask")
    .compile({ checkpointer: new MemorySaver() });
  await graph.invoke({ log: [] }, config(false));

  const result = await graph.invoke(
    new Command({ resume: false }),
    config(false)
  );
  expect(result.log).toEqual(["answered:false"]);
});
