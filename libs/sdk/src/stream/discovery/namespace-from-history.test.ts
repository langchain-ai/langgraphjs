import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../client/index.js";
import type { ThreadState } from "../../schema.js";
import {
  collectSubgraphHostNamespaces,
  mapSubagentNamespaces,
  resolveSubagentNamespaces,
} from "./namespace-from-history.js";

/**
 * Discovery pages recorded from the Python Agent Server (`langgraph-api`
 * 0.18.0rc3), each for one thread of a scripted deepagents agent. The
 * parent called `search`, `task(researcher)` and `task(writer)` in one
 * AIMessage; a human rejected `search` before the subagents were dispatched.
 *  - `one`: the researcher finished, the writer paused on an interrupt.
 *  - `both`: both subagents paused on an interrupt.
 * `lean` pages were requested with `select: ["checkpoint", "tasks"]`, `full`
 * pages without it. `truth` is tool call id → namespace from the live stream.
 */
function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../tests/fixtures/lean-history/${name}.json`, import.meta.url),
      "utf8"
    )
  ) as T;
}

describe("mapSubagentNamespaces on recorded Python pages", () => {
  it.each(["one", "both"])(
    "maps the %s select page to the live-stream truth",
    (scenario) => {
      const page = loadFixture<ThreadState<Record<string, unknown>>[]>(
        `py-${scenario}-lean`
      );
      const truth = loadFixture<Record<string, string>>(`py-${scenario}-truth`);

      const map = mapSubagentNamespaces(page, Object.keys(truth));

      expect(Object.fromEntries(map)).toEqual(truth);
    }
  );

  it.each(["one", "both"])(
    "maps the %s full page the same, ignoring values",
    (scenario) => {
      const page = loadFixture<ThreadState<Record<string, unknown>>[]>(
        `py-${scenario}-full`
      );
      const truth = loadFixture<Record<string, string>>(`py-${scenario}-truth`);

      const map = mapSubagentNamespaces(page, Object.keys(truth));

      expect(Object.fromEntries(map)).toEqual(truth);
    }
  );
});

function checkpoint(ns: string, id: string) {
  return {
    thread_id: "t1",
    checkpoint_ns: ns,
    checkpoint_id: id,
    checkpoint_map: null,
  };
}

type Entry = ThreadState<Record<string, unknown>>;

/**
 * A discovery page entry shaped like a `select: ["checkpoint", "tasks"]`
 * response: no `values`, so matching can only read task results.
 */
function entry(id: string, tasks: unknown[]): Entry {
  return { checkpoint: checkpoint("", id), tasks } as unknown as Entry;
}

/** A node task (not a Send) that wrote `messages`. */
function nodeTask(name: string, messages: unknown) {
  return {
    id: `${name}-uuid`,
    name,
    path: ["__pregel_pull", name],
    result: { messages },
    error: null,
    interrupts: [],
    checkpoint: null,
    state: null,
  };
}

/** A Send task at Send index `index`, with what it wrote if it finished. */
function sendTask(
  id: string,
  index: number,
  opts: { name?: string; path?: unknown[]; messages?: unknown } = {}
) {
  return {
    id,
    name: opts.name ?? "tools",
    path: opts.path ?? ["__pregel_push", index, false],
    ...(opts.messages !== undefined
      ? { result: { messages: opts.messages } }
      : {}),
    error: null,
    interrupts: [],
    checkpoint: null,
    state: null,
  };
}

function aiMessage(toolCalls: Array<{ id: string; name: string }>) {
  return { type: "ai", content: "", tool_calls: toolCalls };
}

function toolMessage(toolCallId: string) {
  return { type: "tool", content: "", tool_call_id: toolCallId };
}

/** An older entry whose model task wrote an AIMessage with these calls. */
function modelEntry(toolCalls: Array<{ id: string; name: string }>): Entry {
  return entry("cp-model", [nodeTask("model", [aiMessage(toolCalls)])]);
}

/** An entry whose finished Send task wrote a ToolMessage for `toolCallId`. */
function directMappingState(
  toolCallId: string,
  taskName: string,
  taskId: string
): Entry {
  return entry(`cp-${taskId}`, [
    sendTask(taskId, 0, {
      name: taskName,
      messages: [toolMessage(toolCallId)],
    }),
  ]);
}

/**
 * Pending Sends for `task` calls, newest first: the Send entry, then the
 * model entry that wrote the AIMessage they index into.
 */
function positionalPage(
  toolCallIds: string[],
  taskNames: string[],
  taskIds: string[]
): Entry[] {
  return [
    entry(
      "cp-pos",
      toolCallIds.map((_id, i) =>
        sendTask(taskIds[i], i, { name: taskNames[i] })
      )
    ),
    modelEntry(toolCallIds.map((id) => ({ id, name: "task" }))),
  ];
}

/** Pending Sends against an AIMessage with mixed tool calls. */
function mixedPositionalPage(
  toolCalls: Array<{ id: string; name: string }>,
  pushTasks: Array<{ taskId: string; index: number }>
): Entry[] {
  return [
    entry(
      "cp-mixed",
      pushTasks.map(({ taskId, index }) => sendTask(taskId, index))
    ),
    modelEntry(toolCalls),
  ];
}

describe("mapSubagentNamespaces", () => {
  it("maps directly from task result tool_call_id", () => {
    const history = [directMappingState("task-1", "tools", "uuid-1")];
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:uuid-1");
  });

  it("falls back to positional Send-index alignment for unmapped ids", () => {
    const history = positionalPage(
      ["task-a", "task-b"],
      ["tools", "tools"],
      ["uuid-a", "uuid-b"]
    );
    const map = mapSubagentNamespaces(history, ["task-a", "task-b"]);
    expect(map.get("task-a")).toBe("tools:uuid-a");
    expect(map.get("task-b")).toBe("tools:uuid-b");
  });

  it("reads positional tool calls from snake_case content_blocks in history", () => {
    const history = [
      entry("cp-content-blocks", [sendTask("uuid-a", 0)]),
      entry("cp-model", [
        nodeTask("model", [
          {
            type: "ai",
            content: [],
            content_blocks: [
              { type: "tool_call", id: "task-a", name: "task", args: {} },
            ],
          },
        ]),
      ]),
    ];

    const map = mapSubagentNamespaces(history, ["task-a"]);
    expect(map.get("task-a")).toBe("tools:uuid-a");
  });

  it("positional fallback indexes path[1] into the full tool_calls array", () => {
    // AI message mixes a normal tool call (index 0) before the subagent
    // `task` call (index 1). Both push tasks are still pending, so only the
    // positional fallback runs. The subagent must resolve to *its own* push
    // task (Send index 1), never the normal tool's push task at index 0.
    const history = mixedPositionalPage(
      [
        { id: "normal-1", name: "search" },
        { id: "task-1", name: "task" },
      ],
      [
        { taskId: "normal-uuid", index: 0 },
        { taskId: "subagent-uuid", index: 1 },
      ]
    );
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:subagent-uuid");
  });

  it("positional fallback maps multiple interleaved subagents by their own index", () => {
    // tool_calls: [search(0), task-a(1), lookup(2), task-b(3)]. Each subagent
    // must land on the push task at its own Send index, never a neighbour's.
    const history = mixedPositionalPage(
      [
        { id: "search-1", name: "search" },
        { id: "task-a", name: "task" },
        { id: "lookup-1", name: "lookup" },
        { id: "task-b", name: "task" },
      ],
      [
        { taskId: "search-uuid", index: 0 },
        { taskId: "a-uuid", index: 1 },
        { taskId: "lookup-uuid", index: 2 },
        { taskId: "b-uuid", index: 3 },
      ]
    );
    const map = mapSubagentNamespaces(history, ["task-a", "task-b"]);
    expect(map.get("task-a")).toBe("tools:a-uuid");
    expect(map.get("task-b")).toBe("tools:b-uuid");
  });

  it("positional fallback ignores a push index out of the tool_calls range", () => {
    // A defensive guard: a push task whose Send index points past the end of
    // tool_calls must not crash or mismap. Only the in-range subagent maps.
    const history = mixedPositionalPage(
      [
        { id: "search-1", name: "search" },
        { id: "task-1", name: "task" },
      ],
      [
        { taskId: "in-range-uuid", index: 1 },
        { taskId: "orphan-uuid", index: 9 },
      ]
    );
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:in-range-uuid");
    expect(map.size).toBe(1);
  });

  it("recognizes all three Send path shapes and rejects handler paths", () => {
    // Legacy JS servers emit `[PUSH, i]`; aligned servers (JS and Python)
    // emit `[PUSH, i, false]`; error handlers of failed Sends emit
    // `[PUSH, i, false, "node_error_handler", false]` and must NOT be
    // mistaken for a second Send at the same index.
    const make = (path: unknown[]) => [
      entry("cp-shape", [sendTask("legacy-uuid", 0, { path })]),
      modelEntry([{ id: "task-1", name: "task" }]),
    ];

    // Legacy two-element path: maps.
    expect(
      mapSubagentNamespaces(make(["__pregel_push", 0]), ["task-1"]).get(
        "task-1"
      )
    ).toBe("tools:legacy-uuid");
    // Aligned three-element path: maps.
    expect(
      mapSubagentNamespaces(make(["__pregel_push", 0, false]), ["task-1"]).get(
        "task-1"
      )
    ).toBe("tools:legacy-uuid");
    // Handler-of-failed-Send path (five elements): not a Send task.
    expect(
      mapSubagentNamespaces(
        make(["__pregel_push", 0, false, "node_error_handler", false]),
        ["task-1"]
      ).size
    ).toBe(0);
    // Call tasks (path[1] is a nested path, not a number): not Send tasks.
    expect(
      mapSubagentNamespaces(
        make(["__pregel_push", ["__pregel_pull", "a"], 0, true]),
        ["task-1"]
      ).size
    ).toBe(0);
  });

  it("prefers direct mapping over positional across the whole history", () => {
    // Newer checkpoint only has a positional (pending) guess; older has the
    // correct direct mapping. Direct must win.
    const history = [
      ...positionalPage(["task-1"], ["tools"], ["WRONG-uuid"]),
      directMappingState("task-1", "tools", "correct-uuid"),
    ];
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:correct-uuid");
  });

  it("skips a call answered before the Sends went out", () => {
    // A human rejected `search` (HITL wrote its ToolMessage) before the two
    // `task` calls were dispatched, so Send 0 is the researcher, not search.
    const history = [
      entry("cp-sends", [sendTask("uuid-r", 0), sendTask("uuid-w", 1)]),
      entry("cp-hitl", [nodeTask("review", [toolMessage("call_s")])]),
      modelEntry([
        { id: "call_s", name: "search" },
        { id: "call_r", name: "task" },
        { id: "call_w", name: "task" },
      ]),
    ];

    const map = mapSubagentNamespaces(history, ["call_r", "call_w"]);

    expect(Object.fromEntries(map)).toEqual({
      call_r: "tools:uuid-r",
      call_w: "tools:uuid-w",
    });
  });

  it("does not let a sibling that answered after dispatch shift the indices", () => {
    // The researcher finished in the Sends' own step; the writer is still
    // running. The researcher's ToolMessage came after dispatch, so the
    // writer is still Send 1.
    const history = [
      entry("cp-sends", [
        sendTask("uuid-r", 0, { messages: [toolMessage("call_r")] }),
        sendTask("uuid-w", 1),
      ]),
      modelEntry([
        { id: "call_r", name: "task" },
        { id: "call_w", name: "task" },
      ]),
    ];

    const map = mapSubagentNamespaces(history, ["call_w"]);

    expect(Object.fromEntries(map)).toEqual({ call_w: "tools:uuid-w" });
  });

  it("indexes into a HITL-edited AIMessage over the model's original", () => {
    const history = [
      entry("cp-sends", [sendTask("uuid-0", 0), sendTask("uuid-1", 1)]),
      entry("cp-hitl", [
        nodeTask("review", [
          aiMessage([
            { id: "call_b", name: "task" },
            { id: "call_a", name: "task" },
          ]),
        ]),
      ]),
      modelEntry([
        { id: "call_a", name: "task" },
        { id: "call_b", name: "task" },
      ]),
    ];

    const map = mapSubagentNamespaces(history, ["call_a", "call_b"]);

    expect(Object.fromEntries(map)).toEqual({
      call_b: "tools:uuid-0",
      call_a: "tools:uuid-1",
    });
  });

  it("leaves unfinished subagents unmatched past a task that had an interrupt and no result", () => {
    // JS history before langgraph-core kept a resumed task's result: HITL
    // rejected `search` and moved it last, but its rewrite isn't on the
    // page. The model's original order would give the researcher the
    // writer's namespace.
    const history = [
      entry("cp-sends", [sendTask("uuid-r", 0), sendTask("uuid-w", 1)]),
      entry("cp-hitl", [
        {
          ...nodeTask("review", []),
          result: undefined,
          interrupts: [{ id: "int-1", value: {} }],
        },
      ]),
      modelEntry([
        { id: "call_s", name: "search" },
        { id: "call_r", name: "task" },
        { id: "call_w", name: "task" },
      ]),
    ];

    const map = mapSubagentNamespaces(history, ["call_r", "call_w"]);

    expect(Object.fromEntries(map)).toEqual({});
  });

  it("does not map a call that doesn't start a subagent", () => {
    const history = mixedPositionalPage(
      [{ id: "call_d", name: "delegate" }],
      [{ taskId: "uuid-d", index: 0 }]
    );

    expect(mapSubagentNamespaces(history, ["call_d"]).size).toBe(0);
  });

  it("honours a custom subagent predicate", () => {
    const history = mixedPositionalPage(
      [{ id: "call_d", name: "delegate" }],
      [{ taskId: "uuid-d", index: 0 }]
    );

    const map = mapSubagentNamespaces(history, ["call_d"], {
      isSubagentToolCall: (name) => name === "delegate",
    });

    expect(map.get("call_d")).toBe("tools:uuid-d");
  });

  it("does not match by id from an error handler of a failed Send", () => {
    // The subagent ran under the failed Send's namespace; the handler that
    // wrote the error ToolMessage has its own.
    const history = [
      entry("cp-handler", [
        sendTask("uuid-handler", 0, {
          path: ["__pregel_push", 0, false, "node_error_handler", false],
          messages: [toolMessage("call_r")],
        }),
      ]),
    ];

    expect(mapSubagentNamespaces(history, ["call_r"]).size).toBe(0);
  });

  it("reads a ToolMessage from a $writes result", () => {
    // A task that wrote the messages channel more than once reports
    // `{ $writes: [...] }`. No AIMessage is on the page, so only a match by
    // id can map the call.
    const history = [
      entry("cp-sends", [
        sendTask("uuid-r", 0, {
          messages: { $writes: [[toolMessage("call_r")], { type: "ai" }] },
        }),
      ]),
    ];

    expect(mapSubagentNamespaces(history, ["call_r"]).get("call_r")).toBe(
      "tools:uuid-r"
    );
  });

  it("reads an AIMessage from a $writes result", () => {
    const history = [
      entry("cp-sends", [sendTask("uuid-w", 0)]),
      entry("cp-model", [
        nodeTask("model", {
          $writes: [[aiMessage([{ id: "call_w", name: "task" }])]],
        }),
      ]),
    ];

    expect(mapSubagentNamespaces(history, ["call_w"]).get("call_w")).toBe(
      "tools:uuid-w"
    );
  });

  it("reads an AIMessage written as a single message", () => {
    const history = [
      entry("cp-sends", [sendTask("uuid-w", 0)]),
      entry("cp-model", [
        nodeTask("model", aiMessage([{ id: "call_w", name: "task" }])),
      ]),
    ];

    expect(mapSubagentNamespaces(history, ["call_w"]).get("call_w")).toBe(
      "tools:uuid-w"
    );
  });
});

describe("resolveSubagentNamespaces", () => {
  it("issues exactly one getHistory call on the happy path", async () => {
    const getHistory = vi.fn(
      async (_threadId: string, _options?: Record<string, unknown>) => [
        directMappingState("task-1", "tools", "uuid-1"),
      ]
    );
    const client = { threads: { getHistory } } as unknown as Client;

    const map = await resolveSubagentNamespaces(client, "t1", ["task-1"]);

    expect(map.get("task-1")).toBe("tools:uuid-1");
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(getHistory.mock.calls[0][1]).not.toHaveProperty("before");
    expect(getHistory.mock.calls[0][1]).toMatchObject({
      limit: 20,
      select: ["checkpoint", "tasks"],
    });
  });

  it("issues exactly one fallback page with a before cursor when unresolved", async () => {
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce([entry("cp-pos", [])]) // page 1: nothing
      .mockResolvedValueOnce([directMappingState("task-1", "tools", "uuid-1")]);
    const client = { threads: { getHistory } } as unknown as Client;

    const map = await resolveSubagentNamespaces(client, "t1", ["task-1"]);

    expect(map.get("task-1")).toBe("tools:uuid-1");
    expect(getHistory).toHaveBeenCalledTimes(2);
    // Fallback page carries a `before` cursor from page 1's oldest entry.
    expect(getHistory.mock.calls[1][1]).toMatchObject({
      before: { configurable: { checkpoint_id: "cp-pos" } },
    });
    // Both pages ask only for what matching reads.
    for (const [, options] of getHistory.mock.calls) {
      expect(options).toMatchObject({
        limit: 20,
        select: ["checkpoint", "tasks"],
      });
    }
  });

  it("matches a Send on page 1 against an AIMessage on the fallback page", async () => {
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce([
        entry("cp-sends", [sendTask("uuid-1", 0)]),
      ])
      .mockResolvedValueOnce([modelEntry([{ id: "task-1", name: "task" }])]);
    const client = { threads: { getHistory } } as unknown as Client;

    const map = await resolveSubagentNamespaces(client, "t1", ["task-1"]);

    expect(map.get("task-1")).toBe("tools:uuid-1");
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it("does not issue a third call (bounded)", async () => {
    const getHistory = vi.fn(async () => [entry("cp-pos", [])]);
    const client = { threads: { getHistory } } as unknown as Client;

    await resolveSubagentNamespaces(client, "t1", ["never-resolves"]);
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it("call count is independent of id count (no per-id fan-out)", async () => {
    const getHistory = vi.fn(async () => [
      directMappingState("task-1", "tools", "uuid-1"),
      directMappingState("task-2", "tools", "uuid-2"),
      directMappingState("task-3", "tools", "uuid-3"),
    ]);
    const client = { threads: { getHistory } } as unknown as Client;

    await resolveSubagentNamespaces(client, "t1", ["task-1", "task-2", "task-3"]);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});

describe("collectSubgraphHostNamespaces", () => {
  function nsState(ns: string): ThreadState<Record<string, unknown>> {
    return {
      values: {},
      next: [],
      checkpoint: checkpoint(ns, `cp-${ns}`),
      metadata: {},
      parent_checkpoint: null,
      tasks: [],
    } as unknown as ThreadState<Record<string, unknown>>;
  }

  it("promotes a single-level (values-only) subgraph host with no deeper namespace", () => {
    // The values-only subgraph shape: a host checkpoint namespace appears
    // with no `research:<uuid>|...` descendant. The old strict-prefix rule
    // dropped these; they must hydrate immediately on reconnect.
    const history = [nsState("research:u2")];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([["research:u2"]]);
    expect(hosts[0].status).toBe("complete");
  });

  it("promotes the host ancestor but not the inner function-node leaf", () => {
    // `inner:u3` is a plain function node inside the `research` subgraph, not
    // a subgraph host. Only the strict ancestor `research:u2` is promoted —
    // mirroring the live SubgraphDiscovery, which never promotes a leaf.
    const history = [
      nsState("research:u2"),
      nsState("research:u2|inner:u3"),
    ];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([["research:u2"]]);
  });

  it("promotes interior hosts but not the deepest leaf in a multi-level chain", () => {
    // a > b > c, all observed. `a` and `a|b` are interior subgraph hosts;
    // the deepest `a|b|c` is a leaf and must not be promoted on its own.
    const history = [
      nsState("a:1"),
      nsState("a:1|b:2"),
      nsState("a:1|b:2|c:3"),
    ];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([
      ["a:1"],
      ["a:1", "b:2"],
    ]);
  });

  it("marks an interior host running when a nested descendant is pending", () => {
    // The newest checkpoint's pending task is the deeper `research:u2|inner:u3`
    // namespace; its `research:u2` ancestor host must report running via the
    // prefix match, not just an exact pending hit.
    const newest = {
      values: {},
      next: ["inner"],
      checkpoint: checkpoint("", "cp-newest"),
      metadata: {},
      parent_checkpoint: null,
      tasks: [
        {
          id: "u3",
          name: "inner",
          path: ["__pregel_pull", "inner"],
          error: null,
          interrupts: [],
          checkpoint: { checkpoint_ns: "research:u2|inner:u3" },
          state: null,
        },
      ],
    } as unknown as ThreadState<Record<string, unknown>>;
    const hosts = collectSubgraphHostNamespaces([newest]);
    expect(hosts).toEqual([{ namespace: ["research:u2"], status: "running" }]);
  });

  it("promotes the host ancestor from a deeper namespace alone (parent off-page)", () => {
    // The parent subgraph's own checkpoint may fall outside the fetched
    // page; its `research:u2` ancestor is still promoted from the deeper
    // `research:u2|inner:u3` namespace, while the inner leaf is not.
    const history = [nsState("research:u2|inner:u3")];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([["research:u2"]]);
  });

  it("tracks mixed running/complete hosts across a parallel fan-out", () => {
    // Newest checkpoint: worker:u1 still pending (running); worker:u2 already
    // finished and only present as a completed task in an older checkpoint.
    const newest = {
      values: {},
      next: ["worker"],
      checkpoint: checkpoint("", "cp-newest"),
      metadata: {},
      parent_checkpoint: null,
      tasks: [
        {
          id: "u1",
          name: "worker",
          path: ["__pregel_pull", "worker"],
          error: null,
          interrupts: [],
          checkpoint: { checkpoint_ns: "worker:u1" },
          state: null,
        },
      ],
    } as unknown as ThreadState<Record<string, unknown>>;
    const history = [newest, nsState("worker:u2")];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts).toEqual([
      { namespace: ["worker:u1"], status: "running" },
      { namespace: ["worker:u2"], status: "complete" },
    ]);
  });

  it("promotes a subgraph ancestor of a nested subagent namespace", () => {
    // A subagent (`tools:*`) running inside a subgraph: the full namespace
    // is internal and skipped, but its `research:u2` host ancestor is not.
    const history = [nsState("research:u2|tools:u4")];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([["research:u2"]]);
  });

  it("excludes tool/subagent namespaces", () => {
    const history = [
      nsState("tools:abc"),
      nsState("tools:abc|model:def"),
      nsState("task:ghi"),
      nsState("task:ghi|inner:jkl"),
    ];
    expect(collectSubgraphHostNamespaces(history)).toEqual([]);
  });

  it("marks a host running when it is pending in the newest checkpoint", () => {
    const newest = {
      values: {},
      next: ["research"],
      checkpoint: checkpoint("", "cp-newest"),
      metadata: {},
      parent_checkpoint: null,
      tasks: [
        {
          id: "u2",
          name: "research",
          path: ["__pregel_pull", "research"],
          error: null,
          interrupts: [],
          checkpoint: { checkpoint_ns: "research:u2" },
          state: null,
        },
      ],
    } as unknown as ThreadState<Record<string, unknown>>;
    const history = [newest];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts).toEqual([{ namespace: ["research:u2"], status: "running" }]);
  });
});
