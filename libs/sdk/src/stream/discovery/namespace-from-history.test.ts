import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../client/index.js";
import type { ThreadState } from "../../schema.js";
import {
  collectSubgraphHostNamespaces,
  mapSubagentNamespaces,
  resolveSubagentNamespaces,
} from "./namespace-from-history.js";

function checkpoint(ns: string, id: string) {
  return {
    thread_id: "t1",
    checkpoint_ns: ns,
    checkpoint_id: id,
    checkpoint_map: null,
  };
}

/** A checkpoint whose completed push task carries a result ToolMessage. */
function directMappingState(
  toolCallId: string,
  taskName: string,
  taskId: string
): ThreadState<Record<string, unknown>> {
  return {
    values: { messages: [] },
    next: [],
    checkpoint: checkpoint("", `cp-${taskId}`),
    metadata: {},
    parent_checkpoint: null,
    tasks: [
      {
        id: taskId,
        name: taskName,
        path: ["__pregel_push", 0],
        result: {
          messages: [{ type: "tool", tool_call_id: toolCallId }],
        },
        error: null,
        interrupts: [],
        checkpoint: null,
        state: null,
      },
    ],
  } as unknown as ThreadState<Record<string, unknown>>;
}

/** A checkpoint whose push tasks are still pending (positional only). */
function positionalState(
  toolCallIds: string[],
  taskNames: string[],
  taskIds: string[]
): ThreadState<Record<string, unknown>> {
  return {
    values: {
      messages: [
        {
          type: "ai",
          tool_calls: toolCallIds.map((id) => ({ id, name: "task" })),
        },
      ],
    },
    next: [],
    checkpoint: checkpoint("", "cp-pos"),
    metadata: {},
    parent_checkpoint: null,
    tasks: toolCallIds.map((_id, i) => ({
      id: taskIds[i],
      name: taskNames[i],
      path: ["__pregel_push", i],
      error: null,
      interrupts: [],
      checkpoint: null,
      state: null,
    })),
  } as unknown as ThreadState<Record<string, unknown>>;
}

/** A pending checkpoint with arbitrary mixed tool_calls and push tasks. */
function mixedPositionalState(
  toolCalls: Array<{ id: string; name: string }>,
  pushTasks: Array<{ taskId: string; index: number }>
): ThreadState<Record<string, unknown>> {
  return {
    values: { messages: [{ type: "ai", tool_calls: toolCalls }] },
    next: [],
    checkpoint: checkpoint("", "cp-mixed"),
    metadata: {},
    parent_checkpoint: null,
    tasks: pushTasks.map(({ taskId, index }) => ({
      id: taskId,
      name: "tools",
      path: ["__pregel_push", index],
      error: null,
      interrupts: [],
      checkpoint: null,
      state: null,
    })),
  } as unknown as ThreadState<Record<string, unknown>>;
}

describe("mapSubagentNamespaces", () => {
  it("maps directly from task result tool_call_id", () => {
    const history = [directMappingState("task-1", "tools", "uuid-1")];
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:uuid-1");
  });

  it("falls back to positional Send-index alignment for unmapped ids", () => {
    const history = [
      positionalState(
        ["task-a", "task-b"],
        ["tools", "tools"],
        ["uuid-a", "uuid-b"]
      ),
    ];
    const map = mapSubagentNamespaces(history, ["task-a", "task-b"]);
    expect(map.get("task-a")).toBe("tools:uuid-a");
    expect(map.get("task-b")).toBe("tools:uuid-b");
  });

  it("reads positional tool calls from snake_case content_blocks in history", () => {
    const history = [
      {
        values: {
          messages: [
            {
              type: "ai",
              content: [],
              content_blocks: [
                { type: "tool_call", id: "task-a", name: "task", args: {} },
              ],
            },
          ],
        },
        next: [],
        checkpoint: checkpoint("", "cp-content-blocks"),
        metadata: {},
        parent_checkpoint: null,
        tasks: [
          {
            id: "uuid-a",
            name: "tools",
            path: ["__pregel_push", 0],
            error: null,
            interrupts: [],
            checkpoint: null,
            state: null,
          },
        ],
      } as unknown as ThreadState<Record<string, unknown>>,
    ];

    const map = mapSubagentNamespaces(history, ["task-a"]);
    expect(map.get("task-a")).toBe("tools:uuid-a");
  });

  it("positional fallback indexes path[1] into the full tool_calls array", () => {
    // AI message mixes a normal tool call (index 0) before the subagent
    // `task` call (index 1). Both push tasks are still pending, so only the
    // positional fallback runs. The subagent must resolve to *its own* push
    // task (Send index 1), never the normal tool's push task at index 0.
    const mixed = mixedPositionalState(
      [
        { id: "normal-1", name: "search" },
        { id: "task-1", name: "task" },
      ],
      [
        { taskId: "normal-uuid", index: 0 },
        { taskId: "subagent-uuid", index: 1 },
      ]
    );
    const map = mapSubagentNamespaces([mixed], ["task-1"]);
    expect(map.get("task-1")).toBe("tools:subagent-uuid");
  });

  it("positional fallback maps multiple interleaved subagents by their own index", () => {
    // tool_calls: [search(0), task-a(1), lookup(2), task-b(3)]. Each subagent
    // must land on the push task at its own Send index, never a neighbour's.
    const mixed = mixedPositionalState(
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
    const map = mapSubagentNamespaces([mixed], ["task-a", "task-b"]);
    expect(map.get("task-a")).toBe("tools:a-uuid");
    expect(map.get("task-b")).toBe("tools:b-uuid");
  });

  it("positional fallback ignores a push index out of the tool_calls range", () => {
    // A defensive guard: a push task whose Send index points past the end of
    // tool_calls must not crash or mismap. Only the in-range subagent maps.
    const mixed = mixedPositionalState(
      [
        { id: "search-1", name: "search" },
        { id: "task-1", name: "task" },
      ],
      [
        { taskId: "in-range-uuid", index: 1 },
        { taskId: "orphan-uuid", index: 9 },
      ]
    );
    const map = mapSubagentNamespaces([mixed], ["task-1"]);
    expect(map.get("task-1")).toBe("tools:in-range-uuid");
    expect(map.size).toBe(1);
  });

  it("prefers direct mapping over positional across the whole history", () => {
    // Newer checkpoint only has a positional (pending) guess; older has the
    // correct direct mapping. Direct must win.
    const history = [
      positionalState(["task-1"], ["tools"], ["WRONG-uuid"]),
      directMappingState("task-1", "tools", "correct-uuid"),
    ];
    const map = mapSubagentNamespaces(history, ["task-1"]);
    expect(map.get("task-1")).toBe("tools:correct-uuid");
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
  });

  it("issues exactly one fallback page with a before cursor when unresolved", async () => {
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce([positionalState([], [], [])]) // page 1: nothing
      .mockResolvedValueOnce([directMappingState("task-1", "tools", "uuid-1")]);
    const client = { threads: { getHistory } } as unknown as Client;

    const map = await resolveSubagentNamespaces(client, "t1", ["task-1"]);

    expect(map.get("task-1")).toBe("tools:uuid-1");
    expect(getHistory).toHaveBeenCalledTimes(2);
    // Fallback page carries a `before` cursor from page 1's oldest entry.
    expect(getHistory.mock.calls[1][1]).toMatchObject({
      before: { configurable: { checkpoint_id: "cp-pos" } },
    });
  });

  it("does not issue a third call (bounded)", async () => {
    const getHistory = vi.fn(async () => [positionalState([], [], [])]);
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
