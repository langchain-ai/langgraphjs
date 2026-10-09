import { describe, expect, it } from "vitest";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { emptyCheckpoint, uuid5 } from "@langchain/langgraph-checkpoint";
import {
  _prepareNextTasks,
  _prepareNodeErrorHandlerTask,
  _prepareSingleTask,
} from "../pregel/algo.js";
import { PregelNode } from "../pregel/read.js";
import { Topic } from "../channels/topic.js";
import { LastValue } from "../channels/last_value.js";
import { TASKS } from "../constants.js";
import { Send } from "../web.js";
import { Call, PregelExecutableTask } from "../pregel/types.js";
import { Command } from "../constants.js";
import { interrupt } from "../interrupt.js";

/**
 * Identity blast radius of the Send/error-handler path alignment
 * (proposal v4 commit 1): the direct Send and handler task-id formulas are
 * unchanged (the path is not part of their hash), but functional `task()`
 * child-call ids hash the parent path, so they change with it — asserted
 * here explicitly, next to the translated-path metadata.
 */

const checkpoint = emptyCheckpoint();
const step = -1;

function makeProcessesAndChannels() {
  const processes = {
    node1: new PregelNode({
      channels: ["channel1"],
      triggers: ["channel1"],
      writers: [new RunnablePassthrough()],
    }),
    handler: new PregelNode({
      channels: ["channel1"],
      triggers: [],
      writers: [new RunnablePassthrough()],
    }),
  };
  const channel1 = new LastValue<number>();
  channel1.update([1]);
  const channelTask = new Topic({ accumulate: false });
  const channels = { channel1, [TASKS]: channelTask };
  return { processes, channels };
}

describe("task path alignment: identity", () => {
  it("a Send task's id keeps its direct formula (no path in the hash)", () => {
    const { processes, channels } = makeProcessesAndChannels();
    channels[TASKS].update([{ node: "node1", args: 1 }]);
    const ckpt = {
      ...checkpoint,
      channel_versions: { ...checkpoint.channel_versions, channel1: 2 },
      // PULL for node1 is filtered (version seen == current), so only the
      // Send task is prepared.
      versions_seen: { node1: { channel1: 2 } },
    };
    const tasks = Object.values(
      _prepareNextTasks(
        ckpt,
        [],
        processes,
        channels,
        { configurable: { thread_id: "foo" } },
        true,
        { step }
      )
    );
    const sendTask = tasks.find((t) => t.triggers[0] === "__pregel_push");
    expect(sendTask).toBeDefined();
    expect(sendTask?.path).toEqual(["__pregel_push", 0, false]);
    // The metadata carries the translated path too (Python uses it for
    // `langgraph_path`), not the raw two-element input path.
    expect((sendTask?.config as { metadata?: unknown } | undefined)?.metadata)
      .toMatchObject({ langgraph_path: ["__pregel_push", 0, false] });
    // The direct formula, unchanged by the alignment: namespace, step, node,
    // trigger, index — hashed with the checkpoint id. No path element.
    expect(sendTask?.id).toBe(
      uuid5(
        JSON.stringify(["node1", String(step), "node1", "__pregel_push", "0"]),
        ckpt.id
      )
    );
  });

  it("a child call's id changes with its parent's path (documented change)", () => {
    // Call ids hash the parent task path (`taskPath[1]`), so appending the
    // trailing `false` to Send paths changes descendant call ids. Before the
    // alignment the parent path was `[PUSH, 2]`; after it it is
    // `[PUSH, 2, false]`.
    const { processes, channels } = makeProcessesAndChannels();
    const config = { configurable: { thread_id: "foo" } };
    const call = new Call({ name: "node1", func: () => void 0, input: 1 });
    const callTaskId = "11111111-1111-1111-1111-111111111111";

    const legacy = _prepareSingleTask(
      ["__pregel_push", ["__pregel_push", 2], 0, callTaskId, call] as never,
      checkpoint,
      [],
      processes,
      channels,
      config,
      true,
      { step }
    ) as PregelExecutableTask<string, string> | undefined;
    const aligned = _prepareSingleTask(
      [
        "__pregel_push",
        ["__pregel_push", 2, false],
        0,
        callTaskId,
        call,
      ] as never,
      checkpoint,
      [],
      processes,
      channels,
      config,
      true,
      { step }
    ) as PregelExecutableTask<string, string> | undefined;

    expect(legacy).toBeDefined();
    expect(aligned).toBeDefined();
    expect(aligned?.id).not.toBe(legacy?.id);
    // Both are the same node at the same write index — only the parent's
    // path shape differs.
    expect(aligned?.name).toBe(legacy?.name);
  });

  it("an error handler's path is the failed task's path plus the handler marker", () => {
    const { processes, channels } = makeProcessesAndChannels();
    // Precise keys so the task is assignable to the handler preparer's
    // PregelExecutableTask<"node1" | "handler", keyof channels>.
    type FailedTask = PregelExecutableTask<"node1", "channel1">;
    const failedPull: FailedTask = {
      name: "node1",
      input: { test: true },
      proc: new RunnablePassthrough(),
      writes: [],
      config: { configurable: { thread_id: "foo" } },
      triggers: ["channel1"],
      path: ["__pregel_pull", "node1"],
      id: "22222222-2222-2222-2222-222222222222",
      writers: [],
    };
    const failedSend: FailedTask = {
      ...failedPull,
      path: ["__pregel_push", 2, false],
    };

    const handlerForPull = _prepareNodeErrorHandlerTask(
      failedPull,
      "handler",
      new Error("boom"),
      checkpoint,
      [],
      processes,
      channels,
      { configurable: { thread_id: "foo" } },
      { step }
    );
    const handlerForSend = _prepareNodeErrorHandlerTask(
      failedSend,
      "handler",
      new Error("boom"),
      checkpoint,
      [],
      processes,
      channels,
      { configurable: { thread_id: "foo" } },
      { step }
    );

    // Python's `(*failed_task.path[:3], "node_error_handler", False)`.
    expect(handlerForPull?.path).toEqual([
      "__pregel_pull",
      "node1",
      "node_error_handler",
      false,
    ]);
    expect(handlerForSend?.path).toEqual([
      "__pregel_push",
      2,
      false,
      "node_error_handler",
      false,
    ]);
    expect(
      (handlerForSend?.config as { metadata?: unknown } | undefined)?.metadata
    ).toMatchObject({
      langgraph_path: [
        "__pregel_push",
        2,
        false,
        "node_error_handler",
        false,
      ],
    });
    // The direct handler id formula is unchanged: the failed task's id is in
    // the hash, not its path.
    expect(handlerForPull?.id).toBe(
      uuid5(
        JSON.stringify([
          "handler",
          String(step),
          "handler",
          "__pregel_push",
          "node_error_handler",
          failedPull.id,
        ]),
        checkpoint.id
      )
    );
  });
});

describe("task path alignment: metadata on real snapshots", () => {
  it("pending Send tasks report the translated langgraph_path", async () => {
    const { Annotation } = await import("../graph/index.js");
    const { StateGraph } = await import("../graph/state.js");
    const { START } = await import("../constants.js");
    const { MemorySaver } = await import("@langchain/langgraph-checkpoint");

    const State = Annotation.Root({
      foo: Annotation<string[]>({
        default: () => [],
        reducer: (a, b) => [...a, ...b],
      }),
    });
    // Captured from the worker's runnable config, before the interrupt —
    // independent of what getState() reports.
    const workerMetadata: unknown[] = [];
    const graph = new StateGraph(State)
      .addNode("worker", (arg: string, config) => {
        workerMetadata.push((config as { metadata?: unknown }).metadata);
        interrupt("hold");
        return { foo: [arg] };
      })
      .addConditionalEdges(START, () => [
        new Send("worker", "a"),
        new Send("worker", "b"),
      ])
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "send-meta" } };
    await graph.invoke({ foo: [] }, config);

    const state = await graph.getState(config);
    // Both pending workers are Send tasks; their paths carry the translated
    // shape, matching Python.
    expect(state.tasks.map((t) => t.path)).toEqual([
      ["__pregel_push", 0, false],
      ["__pregel_push", 1, false],
    ]);
    // ... and so did each worker's own runnable metadata, at run time.
    expect(workerMetadata).toEqual([
      expect.objectContaining({ langgraph_path: ["__pregel_push", 0, false] }),
      expect.objectContaining({ langgraph_path: ["__pregel_push", 1, false] }),
    ]);
  });
});

void Command;
