import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { isGraphBubbleUp, isParentCommand } from "@langchain/langgraph";

import { serializeError } from "./utils/serde.mjs";

// `lifecycle` events for v1 run streams: when each subgraph starts and how it
// ends. A subgraph runs in the namespace `<node>:<task_id>` of the task that
// called it; it starts with the first thing that runs there and ends with that
// task. Runs with `stream_subgraphs` read this from their `debug` task events,
// which arrive in order with the subgraph's own events (`SubgraphLifecycle`).
// Other runs get no subgraph events, so a callback listener sends it as it
// happens (`ChainLifecycle`).

export type LifecycleEvent = {
  event: string;
  data: Record<string, unknown>;
};

function lifecycleEvent(
  ns: string[],
  data: Record<string, unknown>,
  toolCallId: string | undefined
): LifecycleEvent {
  return {
    event: `lifecycle|${ns.join("|")}`,
    data: {
      ...data,
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      namespace: ns,
    },
  };
}

/** The id of the task a namespace segment runs in: `<node>:<task_id>`. */
function taskIdOf(segment: string | undefined): string {
  if (segment == null || !segment.includes(":")) return "";
  return segment.slice(segment.lastIndexOf(":") + 1);
}

/**
 * `ns` without the `|<n>` langgraph appends when a task runs a subgraph again
 * (a retry or a second call), which is still that task's subgraph.
 */
function subgraphNs(ns: string[]): string[] {
  let end = ns.length;
  while (end > 0 && /^\d+$/.test(ns[end - 1])) end -= 1;
  return ns.slice(0, end);
}

/** The id of the one tool call a task runs, in the shapes agents pass it. */
function toolCallIdOf(input: unknown): string | undefined {
  let calls = input;
  if (calls != null && typeof calls === "object" && !Array.isArray(calls)) {
    const record = calls as Record<string, unknown>;
    calls = [record.tool_call ?? record.lg_tool_call];
  }
  if (!Array.isArray(calls) || calls.length !== 1) return undefined;
  const call: unknown = calls[0];
  if (call == null || typeof call !== "object") return undefined;
  if (!("name" in call) || !("args" in call)) return undefined;
  const { id } = call as { id?: unknown };
  return typeof id === "string" ? id : undefined;
}

/** A task result's error is the `{ message, name }` its task wrote. */
function errorData(error: unknown) {
  if (error instanceof Error || error == null || typeof error !== "object") {
    return serializeError(error);
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  return {
    error: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : JSON.stringify(error),
  };
}

/** The namespace of the graph a task's chain runs in, without `@task` call segments. */
function graphNamespace(metadata: Record<string, unknown>): string[] {
  const ns = String(metadata.langgraph_checkpoint_ns).split("|");
  let path = metadata.langgraph_path;
  let drop = 1;
  while (
    Array.isArray(path) &&
    path.length === 4 &&
    path[0] === "__pregel_push" &&
    path[3] === true
  ) {
    drop += 1;
    path = path[1];
  }
  return ns.slice(0, Math.max(ns.length - drop, 0));
}

type DebugTask = {
  id: string;
  input?: unknown;
  interrupts?: unknown[];
  error?: unknown;
};

/** `lifecycle` events from the `debug` task events of a run with `stream_subgraphs`. */
export class SubgraphLifecycle {
  private toolCallIds = new Map<string, string>();

  private open = new Map<string, string[]>();

  onTask(ns: string[], task: DebugTask): LifecycleEvent[] {
    const toolCallId = toolCallIdOf(task.input);
    if (toolCallId) this.toolCallIds.set(task.id, toolCallId);
    const subgraph = subgraphNs(ns);
    const trigger = taskIdOf(subgraph.at(-1));
    if (!trigger || this.open.has(trigger)) return [];
    this.open.set(trigger, subgraph);
    return [
      lifecycleEvent(
        subgraph,
        { event: "started" },
        this.toolCallIds.get(trigger)
      ),
    ];
  }

  onTaskResult(task: DebugTask): LifecycleEvent[] {
    const toolCallId = this.toolCallIds.get(task.id);
    this.toolCallIds.delete(task.id);
    const child = this.open.get(task.id);
    if (child == null) return [];
    this.open.delete(task.id);
    let outcome: Record<string, unknown> = { event: "completed" };
    if (task.interrupts?.length) {
      outcome = { event: "interrupted" };
    } else if (task.error != null) {
      outcome = { event: "failed", error: errorData(task.error) };
    }
    return [lifecycleEvent(child, outcome, toolCallId)];
  }
}

/**
 * `lifecycle` events for a run without `stream_subgraphs`, from the chain
 * callbacks every task fires. A task's own chain is the outermost chain named
 * after its node.
 */
export class ChainLifecycle extends BaseCallbackHandler {
  name = "chain_lifecycle";

  readonly events: LifecycleEvent[] = [];

  private taskByRun = new Map<string, string>();

  private runByTask = new Map<string, string>();

  private toolCallIds = new Map<string, string>();

  private open = new Map<string, string[]>();

  constructor() {
    super({
      ignoreLLM: true,
      ignoreRetriever: true,
      ignoreAgent: true,
      ignoreCustomEvent: true,
      _awaitHandler: true,
    });
  }

  handleChainStart(
    _chain: unknown,
    inputs: unknown,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string
  ) {
    if (metadata?.langgraph_checkpoint_ns == null) return;
    if (tags?.includes("langsmith:hidden")) return;
    const taskId = taskIdOf(String(metadata.langgraph_checkpoint_ns));
    if (runName === metadata.langgraph_node && !this.runByTask.has(taskId)) {
      this.taskByRun.set(runId, taskId);
      this.runByTask.set(taskId, runId);
      const toolCallId = toolCallIdOf(inputs);
      if (toolCallId) this.toolCallIds.set(taskId, toolCallId);
    }
    const ns = subgraphNs(graphNamespace(metadata));
    const trigger = taskIdOf(ns.at(-1));
    if (!trigger || this.open.has(trigger)) return;
    this.open.set(trigger, ns);
    this.events.push(
      lifecycleEvent(ns, { event: "started" }, this.toolCallIds.get(trigger))
    );
  }

  handleChainEnd(_outputs: unknown, runId: string) {
    this.end(runId, { event: "completed" });
  }

  handleChainError(error: unknown, runId: string) {
    const thrown = error ?? undefined;
    if (isParentCommand(thrown)) {
      this.end(runId, { event: "completed" });
    } else if (isGraphBubbleUp(thrown)) {
      this.end(runId, { event: "interrupted" });
    } else {
      this.end(runId, { event: "failed", error: errorData(thrown) });
    }
  }

  private end(runId: string, outcome: Record<string, unknown>) {
    const taskId = this.taskByRun.get(runId);
    if (taskId == null) return;
    this.taskByRun.delete(runId);
    this.runByTask.delete(taskId);
    const toolCallId = this.toolCallIds.get(taskId);
    this.toolCallIds.delete(taskId);
    const child = this.open.get(taskId);
    if (child == null) return;
    this.open.delete(taskId);
    this.events.push(lifecycleEvent(child, outcome, toolCallId));
  }
}
