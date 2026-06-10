import { describe, expect, it } from "vitest";
import type { Event, ToolsEvent, ValuesEvent } from "@langchain/protocol";
import { AIMessage, ToolMessage } from "@langchain/core/messages";

import { SubagentDiscovery } from "./subagents.js";

function valuesEvent(messages: unknown[]): Event {
  return {
    type: "event",
    method: "values",
    params: {
      namespace: [],
      timestamp: Date.now(),
      data: { messages },
    },
  } as ValuesEvent & Event;
}

function toolEvent(data: ToolsEvent["params"]["data"]): Event {
  return {
    type: "event",
    method: "tools",
    params: {
      namespace: ["tools:dispatcher"],
      timestamp: Date.now(),
      data,
    },
  } as ToolsEvent & Event;
}

describe("SubagentDiscovery", () => {
  it("discovers task subagents from root values message snapshots", () => {
    const discovery = new SubagentDiscovery();

    discovery.push(
      valuesEvent([
        new AIMessage({
          id: "orchestrator",
          content: "",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: {
                description: "Search for protocol risks",
                subagent_type: "researcher",
              },
            },
            {
              id: "task-2",
              name: "task",
              args: {
                description: "Inspect the sample dataset",
                subagent_type: "data-analyst",
              },
            },
          ],
        }),
      ])
    );

    expect([...discovery.snapshot.values()]).toMatchObject([
      {
        id: "task-1",
        name: "researcher",
        namespace: ["tools:task-1"],
        status: "running",
        taskInput: "Search for protocol risks",
      },
      {
        id: "task-2",
        name: "data-analyst",
        namespace: ["tools:task-2"],
        status: "running",
        taskInput: "Inspect the sample dataset",
      },
    ]);
  });

  it("discovers task subagents from LC-serialized values messages", () => {
    const discovery = new SubagentDiscovery();

    discovery.push(
      valuesEvent([
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: "orchestrator",
            content: "",
            tool_calls: [
              {
                id: "task-1",
                name: "task",
                args: JSON.stringify({
                  description: "Search for protocol risks",
                  subagent_type: "researcher",
                }),
              },
            ],
          },
        },
      ])
    );

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      id: "task-1",
      name: "researcher",
      namespace: ["tools:task-1"],
      taskInput: "Search for protocol risks",
    });
  });

  it("discovers task subagents from snake_case content_blocks", () => {
    const discovery = new SubagentDiscovery();

    discovery.seedFromCheckpointMessages([
      {
        type: "ai",
        id: "orchestrator",
        content: [],
        content_blocks: [
          {
            type: "tool_call",
            id: "task-1",
            name: "task",
            args: {
              description: "Search from content blocks",
              subagent_type: "researcher",
            },
          },
        ],
      },
    ]);

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      id: "task-1",
      name: "researcher",
      namespace: ["tools:task-1"],
      taskInput: "Search from content blocks",
    });
  });

  it("marks discovered subagents complete from values tool-result messages", () => {
    const discovery = new SubagentDiscovery();

    discovery.push(
      valuesEvent([
        new AIMessage({
          id: "orchestrator",
          content: "",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: {
                description: "Search for protocol risks",
                subagent_type: "researcher",
              },
            },
          ],
        }),
        new ToolMessage({
          id: "tool-result",
          content: "Research completed",
          tool_call_id: "task-1",
          name: "task",
        }),
      ])
    );

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        id: "tool-result",
        content: "Research completed",
      }),
    });
  });

  it("still handles first-level task tool events without subscribing deeper", () => {
    const discovery = new SubagentDiscovery();

    discovery.push(
      toolEvent({
        event: "tool-started",
        tool_call_id: "task-1",
        tool_name: "task",
        input: JSON.stringify({
          description: "Search for protocol risks",
          subagent_type: "researcher",
        }),
      })
    );

    discovery.push(
      toolEvent({
        event: "tool-finished",
        tool_call_id: "task-1",
        output: "Research completed",
      })
    );

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      id: "task-1",
      name: "researcher",
      namespace: ["tools:dispatcher"],
      status: "complete",
      output: "Research completed",
    });
  });

  it("promotes QuickJS-spawned task workers to their own work namespace once observed", () => {
    const discovery = new SubagentDiscovery();

    discovery.push(
      toolEvent({
        event: "tool-started",
        tool_call_id: "worker-call-1",
        tool_name: "task",
        input: JSON.stringify({
          description: "Worker worker-001 covering ecology",
          subagent_type: "fanout-worker",
        }),
      })
    );

    expect(discovery.snapshot.get("worker-call-1")).toMatchObject({
      id: "worker-call-1",
      name: "fanout-worker",
      namespace: ["tools:dispatcher"],
      status: "running",
      taskInput: "Worker worker-001 covering ecology",
    });

    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:worker-call-1"],
        timestamp: Date.now(),
        data: {
          messages: [
            {
              type: "human",
              content: "Worker worker-001 covering ecology",
              id: "worker-human",
            },
          ],
        },
      },
    } as ValuesEvent & Event);

    expect(discovery.snapshot.get("worker-call-1")).toMatchObject({
      id: "worker-call-1",
      name: "fanout-worker",
      namespace: ["tools:worker-call-1"],
      status: "running",
      taskInput: "Worker worker-001 covering ecology",
    });
  });

  it("keeps a task's own work namespace when wrapper tool events arrive later", () => {
    const discovery = new SubagentDiscovery();

    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_123",
            name: "task",
            args: {
              description: "Write a quatrain",
              subagent_type: "quatrain-poet",
            },
          },
        ],
      }),
      ["model_request:root"]
    );

    expect(discovery.snapshot.get("toolu_123")).toMatchObject({
      namespace: ["tools:toolu_123"],
      name: "quatrain-poet",
    });

    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:toolu_123"],
        timestamp: Date.now(),
        data: {
          messages: [{ type: "human", content: "Write a quatrain", id: "h1" }],
        },
      },
    } as ValuesEvent & Event);

    discovery.push({
      type: "event",
      method: "tools",
      params: {
        namespace: ["tools:wrapper-run"],
        timestamp: Date.now(),
        data: {
          event: "tool-started",
          tool_call_id: "toolu_123",
          tool_name: "task",
          input: JSON.stringify({
            description: "Write a quatrain",
            subagent_type: "quatrain-poet",
          }),
        },
      },
    } as ToolsEvent & Event);

    expect(discovery.snapshot.get("toolu_123")).toMatchObject({
      namespace: ["tools:toolu_123"],
      name: "quatrain-poet",
    });
  });

  it("uses a wrapper namespace when task execution starts there", () => {
    const discovery = new SubagentDiscovery();

    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: {
              description: "Search for protocol risks",
              subagent_type: "researcher",
            },
          },
        ],
      }),
      ["model_request:root"]
    );

    discovery.push({
      type: "event",
      method: "tools",
      params: {
        namespace: ["tools:wrapper-run"],
        timestamp: Date.now(),
        data: {
          event: "tool-started",
          tool_call_id: "task-1",
          tool_name: "task",
          input: JSON.stringify({
            description: "Search for protocol risks",
            subagent_type: "researcher",
          }),
        },
      },
    } as ToolsEvent & Event);

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      namespace: ["tools:wrapper-run"],
      name: "researcher",
    });
  });

  it("keeps an observed own namespace ahead of later wrapper values", () => {
    const discovery = new SubagentDiscovery();

    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_123",
            name: "task",
            args: {
              description: "Write a quatrain",
              subagent_type: "quatrain-poet",
            },
          },
        ],
      }),
      ["model_request:root"]
    );

    discovery.push({
      type: "event",
      method: "tools",
      params: {
        namespace: ["tools:wrapper-run"],
        timestamp: Date.now(),
        data: {
          event: "tool-started",
          tool_call_id: "toolu_123",
          tool_name: "task",
          input: JSON.stringify({
            description: "Write a quatrain",
            subagent_type: "quatrain-poet",
          }),
        },
      },
    } as ToolsEvent & Event);

    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:toolu_123"],
        timestamp: Date.now(),
        data: {
          messages: [{ type: "human", content: "Write a quatrain", id: "h1" }],
        },
      },
    } as ValuesEvent & Event);

    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:wrapper-run"],
        timestamp: Date.now(),
        data: {
          messages: [{ type: "human", content: "wrapper state", id: "h2" }],
        },
      },
    } as ValuesEvent & Event);

    expect(discovery.snapshot.get("toolu_123")).toMatchObject({
      namespace: ["tools:toolu_123"],
      name: "quatrain-poet",
    });
  });

  it("can be driven by assembled root messages from StreamController", () => {
    const discovery = new SubagentDiscovery();
    const commits: Event[] = [];
    discovery.store.subscribe(() => {
      commits.push({} as Event);
    });

    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: {
              description: "Search for protocol risks",
              subagent_type: "researcher",
            },
          },
        ],
      }),
      ["model_request:root"]
    );

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      name: "researcher",
      namespace: ["tools:task-1"],
    });
    expect(commits).toHaveLength(1);
  });

  // When two parallel dispatches share the same `taskInput` (LLM
  // re-uses a description, or the prompt asks for N copies of the
  // same task), the content match alone is ambiguous. Pregel
  // dispatches and starts executions in superstep order, so FIFO
  // attribution by dispatch order matches execution start order.
  it("attributes duplicate-taskInput dispatches to executions in FIFO order", () => {
    const discovery = new SubagentDiscovery();

    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_A",
            name: "task",
            args: {
              description: "Write a haiku",
              subagent_type: "haiku-drafter",
            },
          },
          {
            id: "toolu_B",
            name: "task",
            args: {
              description: "Write a haiku",
              subagent_type: "haiku-drafter",
            },
          },
        ],
      }),
      []
    );

    // First execution fires.
    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:exec-X"],
        timestamp: Date.now(),
        data: { messages: [{ type: "human", content: "Write a haiku" }] },
      },
    } as ValuesEvent & Event);

    // Second execution fires.
    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:exec-Y"],
        timestamp: Date.now() + 1,
        data: { messages: [{ type: "human", content: "Write a haiku" }] },
      },
    } as ValuesEvent & Event);

    expect(discovery.snapshot.get("toolu_A")?.namespace).toEqual([
      "tools:exec-X",
    ]);
    expect(discovery.snapshot.get("toolu_B")?.namespace).toEqual([
      "tools:exec-Y",
    ]);
  });

  // Deepagents-style: the parent's task tool call uses an Anthropic id
  // (`toolu_*`), but the subagent's pregel execution emits at a
  // distinct `tools:<uuid>` namespace. The wire carries no explicit
  // link — taskInput → HumanMessage content is the deterministic one.
  it("promotes deepagents-style subagents to the execution namespace by matching HumanMessage content to taskInput", () => {
    const discovery = new SubagentDiscovery();

    // Coordinator dispatches; subagent will execute under a distinct UUID.
    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_haiku",
            name: "task",
            args: {
              description: "Write a haiku about cats",
              subagent_type: "haiku-drafter",
            },
          },
        ],
      }),
      []
    );

    expect(discovery.snapshot.get("toolu_haiku")).toMatchObject({
      id: "toolu_haiku",
      name: "haiku-drafter",
      namespace: ["tools:toolu_haiku"],
      taskInput: "Write a haiku about cats",
    });

    // First values event at the execution namespace seeds the
    // subagent with a HumanMessage of the taskInput.
    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:exec-uuid-123"],
        timestamp: Date.now(),
        data: {
          messages: [
            {
              type: "human",
              content: "Write a haiku about cats",
              id: "subagent-human-1",
            },
          ],
        },
      },
    } as ValuesEvent & Event);

    // Subagent should now point at the execution namespace so
    // `useMessages(stream, subagent)` resolves to the right scope.
    expect(discovery.snapshot.get("toolu_haiku")).toMatchObject({
      id: "toolu_haiku",
      name: "haiku-drafter",
      namespace: ["tools:exec-uuid-123"],
    });
  });

  it("seedFromCheckpointMessages discovers task calls and marks completion", () => {
    const discovery = new SubagentDiscovery();

    discovery.seedFromCheckpointMessages([
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { description: "Do research", subagent_type: "researcher" },
          },
        ],
      }),
      new ToolMessage({
        id: "tool-result",
        content: "done",
        tool_call_id: "task-1",
        name: "task",
      }),
    ]);

    expect(discovery.snapshot.get("task-1")).toMatchObject({
      name: "researcher",
      namespace: ["tools:task-1"],
      status: "complete",
    });
  });

  it("seedFromCheckpointMessages is idempotent on re-seed", () => {
    const discovery = new SubagentDiscovery();
    const messages = [
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { description: "Do research", subagent_type: "researcher" },
          },
        ],
      }),
    ];
    discovery.seedFromCheckpointMessages(messages);
    discovery.seedFromCheckpointMessages(messages);
    expect(discovery.snapshot.size).toBe(1);
  });

  it("applyExecutionNamespace promotes a default-only subagent", () => {
    const discovery = new SubagentDiscovery();
    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_haiku",
            name: "task",
            args: { description: "Write a haiku", subagent_type: "poet" },
          },
        ],
      }),
      []
    );
    expect(discovery.snapshot.get("toolu_haiku")?.namespace).toEqual([
      "tools:toolu_haiku",
    ]);

    discovery.applyExecutionNamespace("toolu_haiku", "tools:exec-uuid");
    expect(discovery.snapshot.get("toolu_haiku")?.namespace).toEqual([
      "tools:exec-uuid",
    ]);
  });

  it("applyExecutionNamespace does not demote an observed own namespace", () => {
    const discovery = new SubagentDiscovery();
    discovery.discoverFromMessage(
      new AIMessage({
        id: "orchestrator",
        content: "",
        tool_calls: [
          {
            id: "toolu_123",
            name: "task",
            args: { description: "Write a quatrain", subagent_type: "poet" },
          },
        ],
      }),
      ["model_request:root"]
    );
    // Observe the subagent's own namespace carrying state.
    discovery.push({
      type: "event",
      method: "values",
      params: {
        namespace: ["tools:toolu_123"],
        timestamp: Date.now(),
        data: {
          messages: [{ type: "human", content: "Write a quatrain", id: "h1" }],
        },
      },
    } as ValuesEvent & Event);
    expect(discovery.snapshot.get("toolu_123")?.namespace).toEqual([
      "tools:toolu_123",
    ]);

    // A history-derived wrapper namespace must NOT demote it.
    discovery.applyExecutionNamespace("toolu_123", "tools:wrapper-run");
    expect(discovery.snapshot.get("toolu_123")?.namespace).toEqual([
      "tools:toolu_123",
    ]);
  });

  it("reset clears committed subagent maps", () => {
    const discovery = new SubagentDiscovery();
    discovery.push(
      valuesEvent([
        new AIMessage({
          id: "orchestrator",
          content: "",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: {
                description: "Search for protocol risks",
                subagent_type: "researcher",
              },
            },
          ],
        }),
      ])
    );
    expect(discovery.snapshot.size).toBeGreaterThan(0);

    discovery.reset();

    expect(discovery.snapshot.size).toBe(0);
  });
});
