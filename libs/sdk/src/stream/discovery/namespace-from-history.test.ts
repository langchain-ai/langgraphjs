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
): ThreadState {
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
  } as unknown as ThreadState;
}

/** A checkpoint whose push tasks are still pending (positional only). */
function positionalState(
  toolCallIds: string[],
  taskNames: string[],
  taskIds: string[]
): ThreadState {
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
  } as unknown as ThreadState;
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
    const getHistory = vi.fn(async () => [
      directMappingState("task-1", "tools", "uuid-1"),
    ]);
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
  function nsState(ns: string): ThreadState {
    return {
      values: {},
      next: [],
      checkpoint: checkpoint(ns, `cp-${ns}`),
      metadata: {},
      parent_checkpoint: null,
      tasks: [],
    } as unknown as ThreadState;
  }

  it("promotes only namespaces that host a strictly-deeper namespace", () => {
    const history = [
      nsState("orchestrator:u1"),
      nsState("research:u2"),
      nsState("research:u2|researcher:u3"),
      nsState("writer:u5"),
    ];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts.map((h) => h.namespace)).toEqual([["research:u2"]]);
    expect(hosts[0].status).toBe("complete");
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
    } as unknown as ThreadState;
    const history = [newest, nsState("research:u2|researcher:u3")];
    const hosts = collectSubgraphHostNamespaces(history);
    expect(hosts).toEqual([{ namespace: ["research:u2"], status: "running" }]);
  });
});
