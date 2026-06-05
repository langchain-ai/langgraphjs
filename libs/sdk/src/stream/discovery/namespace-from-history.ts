/**
 * Reconstruct discovery namespaces from checkpoint history.
 *
 * On reconnect the always-on SSE replay eventually re-derives every
 * subagent execution namespace and every subgraph host, but that costs
 * a full depth-1 replay. This module derives the same information from
 * a single bounded `getHistory()` read so the controller can promote
 * namespaces immediately on `hydrate()` (subgraph hosts + subagent
 * execution namespaces) and lazily for a single opened subagent.
 *
 * The logic mirrors the live discovery state machines so a
 * history-derived namespace and an SSE-derived one cannot disagree:
 *  - subagent mapping ports {@link ../../ui/manager} `fetchSubagentHistory`
 *    (direct task-result mapping, then positional Send-index fallback);
 *  - subgraph host detection ports the strict-prefix promotion rule in
 *    {@link ./subgraphs}.
 */
import type { Client } from "../../client/index.js";
import type { Config, ThreadState } from "../../schema.js";
import { NAMESPACE_SEPARATOR } from "../constants.js";
import { namespaceKey } from "../namespace.js";

type AnyCheckpoint = ThreadState<Record<string, unknown>>;

interface HistoryTask {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  result?: { messages?: unknown[] };
  checkpoint?: { checkpoint_ns?: unknown } | null;
}

function getTasks(checkpoint: AnyCheckpoint): HistoryTask[] {
  const tasks = (checkpoint as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? (tasks as HistoryTask[]) : [];
}

/**
 * Phase 1 (preferred): map a `task` tool-call id directly to its
 * execution namespace via the task's result `ToolMessage`. Unambiguous
 * — works even when a step mixes subagent and non-subagent tool calls.
 *
 * The subgraph checkpoint_ns is `task.name + ":" + task.id` (mirrors
 * pregel's `taskCheckpointNamespace`), so we derive it from name+id
 * rather than the always-null completed-task checkpoint.
 */
export function collectDirectTaskMappings(
  tasks: HistoryTask[],
  targets: Set<string>,
  out: Map<string, string>
): void {
  for (const task of tasks) {
    if (
      !Array.isArray(task.path) ||
      task.path[0] !== "__pregel_push" ||
      typeof task.id !== "string" ||
      typeof task.name !== "string"
    ) {
      continue;
    }
    const resultMessages = task.result?.messages;
    if (!Array.isArray(resultMessages)) continue;
    for (const msg of resultMessages) {
      const m = msg as Record<string, unknown>;
      const id = m.tool_call_id;
      if (
        m.type === "tool" &&
        typeof id === "string" &&
        targets.has(id) &&
        !out.has(id)
      ) {
        out.set(id, `${task.name}:${task.id}`);
      }
    }
  }
}

/**
 * Phase 2 (fallback): align still-pending push tasks to the triggering
 * AI message's `task` tool calls by Send index (`path[1]`). Applied
 * only to ids Phase 1 could not resolve so a correct direct mapping is
 * never overwritten by a positional guess.
 */
export function collectPositionalTaskMappings(
  checkpoint: AnyCheckpoint,
  targets: Set<string>,
  out: Map<string, string>,
  messagesKey: string
): void {
  const pushTasks = getTasks(checkpoint).filter(
    (t) =>
      Array.isArray(t.path) &&
      t.path[0] === "__pregel_push" &&
      typeof t.path[1] === "number" &&
      typeof t.id === "string" &&
      typeof t.name === "string"
  );
  if (pushTasks.length === 0) return;

  const msgs = (checkpoint.values as Record<string, unknown> | undefined)?.[
    messagesKey
  ];
  if (!Array.isArray(msgs)) return;

  let aiMessage: Record<string, unknown> | undefined;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i] as Record<string, unknown>;
    if (
      m.type === "ai" &&
      Array.isArray(m.tool_calls) &&
      (m.tool_calls as Array<{ name?: string }>).some(
        (tc) => tc.name === "task"
      )
    ) {
      aiMessage = m;
      break;
    }
  }
  if (aiMessage == null) return;

  const subagentToolCalls = (
    aiMessage.tool_calls as Array<{ id?: string; name?: string }>
  ).filter((tc) => tc.name === "task");
  if (subagentToolCalls.length === 0) return;

  const sorted = [...pushTasks].sort((a, b) => {
    const ai = Array.isArray(a.path) ? (a.path[1] as number) : 0;
    const bi = Array.isArray(b.path) ? (b.path[1] as number) : 0;
    return ai - bi;
  });

  for (let i = 0; i < sorted.length && i < subagentToolCalls.length; i += 1) {
    const tc = subagentToolCalls[i];
    const task = sorted[i];
    if (
      tc?.id != null &&
      typeof task.id === "string" &&
      typeof task.name === "string" &&
      targets.has(tc.id) &&
      !out.has(tc.id)
    ) {
      out.set(tc.id, `${task.name}:${task.id}`);
    }
  }
}

/** Build a `getHistory` `before` cursor from a history entry. */
function beforeCursor(entry: AnyCheckpoint): Config | undefined {
  const checkpointId = entry.checkpoint?.checkpoint_id;
  if (typeof checkpointId !== "string") return undefined;
  return { configurable: { checkpoint_id: checkpointId } };
}

function applyCollectors(
  history: AnyCheckpoint[],
  targets: Set<string>,
  out: Map<string, string>,
  messagesKey: string
): void {
  for (const checkpoint of history) {
    collectDirectTaskMappings(getTasks(checkpoint), targets, out);
  }
  const stillUnmapped = () => [...targets].some((id) => !out.has(id));
  if (stillUnmapped()) {
    for (const checkpoint of history) {
      if (!stillUnmapped()) break;
      collectPositionalTaskMappings(checkpoint, targets, out, messagesKey);
    }
  }
}

/**
 * Synchronous subagent namespace mapping over an already-fetched
 * history page. Used by {@link resolveSubagentNamespaces} and by the
 * controller's hydrate-time bulk seed (which shares a single
 * `getHistory` page with subgraph host detection).
 */
export function mapSubagentNamespaces(
  history: AnyCheckpoint[],
  toolCallIds: string[],
  messagesKey = "messages"
): Map<string, string> {
  const out = new Map<string, string>();
  const targets = new Set(toolCallIds);
  if (targets.size === 0) return out;
  applyCollectors(history, targets, out, messagesKey);
  return out;
}

/**
 * Resolve execution namespaces for the given subagent `task` tool-call
 * ids from checkpoint history.
 *
 * Bounded and O(1) in calls: one `getHistory` page, plus at most one
 * `before`-cursor fallback page when the first leaves ids unresolved.
 * Never fans out per id.
 *
 * @returns Map of `toolCallId` → single execution namespace segment
 *   (e.g. `tools:<uuid>`). Unresolved ids are omitted.
 */
export async function resolveSubagentNamespaces<TStateType>(
  client: Client<TStateType>,
  threadId: string,
  toolCallIds: string[],
  opts?: { limit?: number; messagesKey?: string; signal?: AbortSignal }
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const targets = new Set(toolCallIds);
  if (targets.size === 0) return out;

  const limit = opts?.limit ?? 20;
  const messagesKey = opts?.messagesKey ?? "messages";
  const signal = opts?.signal;

  const page1 = await getHistoryPage(client, threadId, { limit, signal });
  applyCollectors(page1, targets, out, messagesKey);

  const unresolved = [...targets].filter((id) => !out.has(id));
  if (unresolved.length > 0 && page1.length > 0) {
    const before = beforeCursor(page1[page1.length - 1]);
    if (before != null) {
      const page2 = await getHistoryPage(client, threadId, {
        limit,
        before,
        signal,
      });
      applyCollectors(page2, targets, out, messagesKey);
    }
  }

  return out;
}

/**
 * Fetch one bounded history page typed as plain records, sidestepping
 * the client's `TStateType` generic so the discovery collectors (which
 * read raw `values`/`tasks`) get a stable {@link AnyCheckpoint} shape.
 */
export function getHistoryPage<TStateType>(
  client: Client<TStateType>,
  threadId: string,
  options: { limit?: number; before?: Config; signal?: AbortSignal }
): Promise<AnyCheckpoint[]> {
  return client.threads.getHistory<Record<string, unknown>>(threadId, options);
}

export interface SubgraphHost {
  namespace: string[];
  status: "running" | "complete" | "error";
}

function checkpointNsToSegments(checkpointNs: unknown): string[] {
  if (typeof checkpointNs !== "string" || checkpointNs.length === 0) return [];
  return checkpointNs.split("|").filter((segment) => segment.length > 0);
}

function isInternalSegment(segment: string): boolean {
  return segment.startsWith("tools:") || segment.startsWith("task:");
}

/**
 * Identify subgraph host namespaces from checkpoint history by the same
 * strict-prefix rule the live runner uses: a namespace is a host iff a
 * strictly-deeper namespace was observed with it as a prefix.
 *
 * Tool/subagent namespaces (`tools:` / `task:`) are excluded — those are
 * owned by {@link ./subagents} and must not be duplicated as subgraphs
 * (mirrors `SubgraphDiscovery.#onValuesEvent`).
 */
export function collectSubgraphHostNamespaces(
  history: AnyCheckpoint[]
): SubgraphHost[] {
  // Collect every observed namespace tuple (state + task checkpoint_ns).
  const observed = new Map<string, string[]>();
  const record = (segments: string[]) => {
    if (segments.length === 0) return;
    observed.set(namespaceKey(segments), segments);
  };
  for (const state of history) {
    record(checkpointNsToSegments(state.checkpoint?.checkpoint_ns));
    for (const task of getTasks(state)) {
      record(checkpointNsToSegments(task.checkpoint?.checkpoint_ns));
    }
  }

  // Pending namespaces of the newest checkpoint → still running.
  const pending = new Set<string>();
  if (history.length > 0) {
    for (const task of getTasks(history[0])) {
      const segments = checkpointNsToSegments(task.checkpoint?.checkpoint_ns);
      if (segments.length > 0) pending.add(namespaceKey(segments));
    }
  }

  const keys = [...observed.keys()];
  const hosts: SubgraphHost[] = [];
  for (const key of keys) {
    const segments = observed.get(key)!;
    if (segments.some(isInternalSegment)) continue;
    const prefix = key + NAMESPACE_SEPARATOR;
    const isHost = keys.some((other) => other.startsWith(prefix));
    if (!isHost) continue;
    const running =
      pending.has(key) || [...pending].some((p) => p.startsWith(prefix));
    hosts.push({
      namespace: segments,
      status: running ? "running" : "complete",
    });
  }
  return hosts;
}
