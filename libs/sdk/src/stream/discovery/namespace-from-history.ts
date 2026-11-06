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
 * Subagent matching ({@link mapSubagentNamespaces}) is shared with the
 * legacy `StreamManager.fetchSubagentHistory` in {@link ../../ui/manager},
 * so both hooks match the same way after a reload. It reads only
 * `checkpoint` and `tasks`, so the discovery page is requested with
 * `select: ["checkpoint", "tasks"]`. Subgraph host detection ports the
 * strict-prefix promotion rule in {@link ./subgraphs}.
 */
import type { Client } from "../../client/index.js";
import type {
  Checkpoint,
  Config,
  Metadata,
  ThreadState,
  ThreadStateSelectField,
} from "../../schema.js";
import { NAMESPACE_SEPARATOR, DEFAULT_MESSAGES_KEY } from "../constants.js";
import { namespaceKey } from "../namespace.js";
import { normalizeAIMessageToolCalls } from "../message-coercion.js";

type AnyCheckpoint = ThreadState<Record<string, unknown>>;

/**
 * A discovery page entry as far as subagent matching is concerned: only
 * its tasks are read.
 */
type HistoryEntry = { readonly tasks?: unknown };

interface HistoryTask {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  result?: unknown;
  interrupts?: unknown;
  checkpoint?: { checkpoint_ns?: unknown } | null;
}

/** A task the parent dispatched with `Send`; its namespace is `name:id`. */
interface SendTask extends HistoryTask {
  id: string;
  name: string;
  path: ["__pregel_push", number, ...unknown[]];
}

interface ToolCallRef {
  id?: string;
  name?: string;
}

type SerializedMessage = Record<string, unknown>;

/**
 * What a discovery page request asks for. Matching reads only `tasks`,
 * subgraph host detection reads `checkpoint` and `tasks`, and the `before`
 * cursor reads `checkpoint`. Servers that don't know `select` ignore it and
 * send full pages, which match the same way.
 */
export const DISCOVERY_HISTORY_SELECT: ThreadStateSelectField[] = [
  "checkpoint",
  "tasks",
];

function getTasks(checkpoint: HistoryEntry): HistoryTask[] {
  const { tasks } = checkpoint;
  return Array.isArray(tasks) ? (tasks as HistoryTask[]) : [];
}

/**
 * Send tasks are `[PUSH, i]` (legacy JS servers) or `[PUSH, i, false]`
 * (aligned with Python). Longer paths are error handlers of failed Sends
 * (`[PUSH, i, false, "node_error_handler", false]`), and a non-numeric
 * `path[1]` is a functional-API call; neither is a Send.
 */
function isSendTask(task: HistoryTask): task is SendTask {
  return (
    Array.isArray(task.path) &&
    task.path[0] === "__pregel_push" &&
    typeof task.path[1] === "number" &&
    task.path.length <= 3 &&
    typeof task.id === "string" &&
    typeof task.name === "string"
  );
}

/**
 * The subgraph checkpoint_ns is `task.name + ":" + task.id` (mirrors
 * pregel's `taskCheckpointNamespace`), so it's derived from name+id
 * rather than the always-null completed-task checkpoint.
 */
function sendNamespace(task: SendTask): string {
  return `${task.name}:${task.id}`;
}

/**
 * The messages a task wrote. The channel value can be a list, a single
 * message, or `{ $writes: [...] }` when the task wrote the channel more
 * than once; all three are flattened.
 */
function messagesOf(result: unknown, messagesKey: string): SerializedMessage[] {
  if (result == null || typeof result !== "object") return [];
  const flatten = (value: unknown): SerializedMessage[] => {
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value == null || typeof value !== "object") return [];
    const writes = (value as { $writes?: unknown }).$writes;
    if (Array.isArray(writes)) return writes.flatMap(flatten);
    return [value as SerializedMessage];
  };
  return flatten((result as Record<string, unknown>)[messagesKey]);
}

function toolCallsOf(message: SerializedMessage): ToolCallRef[] {
  if (message.type !== "ai") return [];
  const normalized = normalizeAIMessageToolCalls(
    message as unknown as Parameters<typeof normalizeAIMessageToolCalls>[0]
  ) as { tool_calls?: unknown };
  return Array.isArray(normalized.tool_calls)
    ? (normalized.tool_calls as ToolCallRef[])
    : [];
}

function answeredToolCallId(message: SerializedMessage): string | undefined {
  return message.type === "tool" && typeof message.tool_call_id === "string"
    ? message.tool_call_id
    : undefined;
}

/**
 * Match by id: a Send task whose result holds a ToolMessage for a target
 * call ran that call. Unambiguous, so it's applied across the whole page
 * before any match by index.
 */
function matchById(
  history: readonly HistoryEntry[],
  targets: Set<string>,
  out: Map<string, string>,
  messagesKey: string
): void {
  for (const entry of history) {
    for (const task of getTasks(entry)) {
      if (!isSendTask(task)) continue;
      for (const message of messagesOf(task.result, messagesKey)) {
        const id = answeredToolCallId(message);
        if (id != null && targets.has(id) && !out.has(id)) {
          out.set(id, sendNamespace(task));
        }
      }
    }
  }
}

function hadInterruptWithoutResult(task: HistoryTask): boolean {
  return (
    Array.isArray(task.interrupts) &&
    task.interrupts.length > 0 &&
    task.result == null
  );
}

/**
 * The tool calls the Sends in `history[index]` index into, rebuilt from
 * older entries' task results.
 *
 * Walks older entries newest to oldest up to the first one whose results
 * hold an AIMessage with tool calls: the latest version of the message
 * that made the Sends, so a HITL edit wins over the model's original.
 * ToolMessages seen on the way answered their call before dispatch, so
 * those calls got no Send and are dropped. The Send entry's own results
 * are siblings that answered after dispatch and don't count.
 *
 * Returns `undefined` when no such AIMessage is on the page, or when the
 * walk passes a task that had an interrupt and has no result.
 */
function dispatchedToolCalls(
  history: readonly HistoryEntry[],
  index: number,
  messagesKey: string
): ToolCallRef[] | undefined {
  const answered = new Set<string>();
  for (const older of history.slice(index + 1)) {
    let toolCalls: ToolCallRef[] | undefined;
    for (const task of getTasks(older)) {
      // Older `@langchain/langgraph` versions drop a resumed task's result,
      // so a HITL rewrite may be missing.
      if (hadInterruptWithoutResult(task)) return undefined;
      for (const message of messagesOf(task.result, messagesKey)) {
        const id = answeredToolCallId(message);
        if (id != null) answered.add(id);
        const calls = toolCallsOf(message);
        if (calls.length > 0) toolCalls ??= calls;
      }
    }
    if (toolCalls != null) {
      return toolCalls.filter((tc) => tc.id == null || !answered.has(tc.id));
    }
  }
  return undefined;
}

/**
 * Match by index: Send `i` ran the `i`-th call that was still unanswered
 * when the Sends went out. Only ids still unmatched are mapped, so a
 * match by id is never overwritten.
 */
function matchByIndex(
  history: readonly HistoryEntry[],
  targets: Set<string>,
  out: Map<string, string>,
  messagesKey: string,
  isSubagentToolCall: (name: string) => boolean
): void {
  for (let index = 0; index < history.length; index += 1) {
    if (out.size === targets.size) return;
    const sends = getTasks(history[index]).filter(isSendTask);
    if (sends.length === 0) continue;
    const toolCalls = dispatchedToolCalls(history, index, messagesKey);
    if (toolCalls == null) continue;
    for (const send of sends) {
      const tc = toolCalls[send.path[1]];
      if (
        tc?.id != null &&
        typeof tc.name === "string" &&
        isSubagentToolCall(tc.name) &&
        targets.has(tc.id) &&
        !out.has(tc.id)
      ) {
        out.set(tc.id, sendNamespace(send));
      }
    }
  }
}

export interface MapSubagentNamespacesOptions {
  /**
   * Whether a tool call starts a subagent, by tool name.
   * @default name === "task"
   */
  isSubagentToolCall?: (name: string) => boolean;
  /**
   * The state key tasks write messages to.
   * @default "messages"
   */
  messagesKey?: string;
}

const isTaskToolCall = (name: string) => name === "task";

/**
 * Match subagent tool calls to their subagent namespaces from a discovery
 * page (root-thread history, newest first).
 *
 * Reads only `tasks[].path`, `tasks[].id`, `tasks[].name`,
 * `tasks[].result` and `tasks[].interrupts`, never `values`, so a
 * `select: ["checkpoint", "tasks"]` page and a full page give the same
 * result. Shared by both hooks.
 *
 * @returns Map of tool call id → subagent namespace (e.g. `tools:<uuid>`).
 *   Ids that can't be matched are omitted.
 */
export function mapSubagentNamespaces(
  history: readonly HistoryEntry[],
  toolCallIds: Iterable<string>,
  options?: MapSubagentNamespacesOptions
): Map<string, string> {
  const out = new Map<string, string>();
  const targets = new Set(toolCallIds);
  if (targets.size === 0) return out;
  const messagesKey = options?.messagesKey ?? DEFAULT_MESSAGES_KEY;
  matchById(history, targets, out, messagesKey);
  matchByIndex(
    history,
    targets,
    out,
    messagesKey,
    options?.isSubagentToolCall ?? isTaskToolCall
  );
  return out;
}

/** Build a `getHistory` `before` cursor from a history entry. */
function beforeCursor(entry: AnyCheckpoint): Config | undefined {
  const checkpointId = entry.checkpoint?.checkpoint_id;
  if (typeof checkpointId !== "string") return undefined;
  return { configurable: { checkpoint_id: checkpointId } };
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
  const targets = new Set(toolCallIds);
  if (targets.size === 0) return new Map();

  const limit = opts?.limit ?? 20;
  const signal = opts?.signal;
  const matchOptions = { messagesKey: opts?.messagesKey };

  const page1 = await getHistoryPage(client, threadId, {
    limit,
    select: DISCOVERY_HISTORY_SELECT,
    signal,
  });
  const out = mapSubagentNamespaces(page1, targets, matchOptions);
  if (out.size === targets.size || page1.length === 0) return out;

  const before = beforeCursor(page1[page1.length - 1]);
  if (before == null) return out;
  const page2 = await getHistoryPage(client, threadId, {
    limit,
    before,
    select: DISCOVERY_HISTORY_SELECT,
    signal,
  });
  // Page 2 is older, so the two pages form one newest-first history: a
  // Send near the end of page 1 can find its AIMessage on page 2.
  return mapSubagentNamespaces([...page1, ...page2], targets, matchOptions);
}

/**
 * Fetch one bounded history page typed as plain records, sidestepping
 * the client's `TStateType` generic so callers that read raw
 * `values`/`tasks` get a stable {@link AnyCheckpoint} shape.
 */
export function getHistoryPage<TStateType>(
  client: Client<TStateType>,
  threadId: string,
  options: {
    limit?: number;
    before?: Config;
    checkpoint?: Partial<Omit<Checkpoint, "thread_id">>;
    metadata?: Metadata;
    select?: ThreadStateSelectField[];
    signal?: AbortSignal;
  }
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
 * Identify subgraph host namespaces from checkpoint history, mirroring the
 * promotion rule of the live {@link ./subgraphs} `SubgraphDiscovery`: a
 * namespace is a host iff it is a *strict ancestor* of a deeper namespace,
 * and inner function-node leaves are never promoted on their own.
 *
 * Two host signals are derived from the checkpoint namespaces observed in
 * history (`state` + `task` `checkpoint_ns`):
 *
 *  - **Interior hosts** — every strict ancestor of an observed namespace.
 *    Each segment of a nested `checkpoint_ns` wraps a deeper one, so the
 *    parent is always a subgraph (this also recovers a host whose own
 *    checkpoint fell outside the fetched page).
 *  - **Top-level hosts** — every depth-1 observed namespace. A top-level
 *    subgraph is always a host, including the values-only shape supported
 *    by `SubgraphDiscovery.#onValuesEvent`, where the host (e.g.
 *    `research:<uuid>`) appears with no deeper `research:<uuid>|...` key.
 *    The old strict-prefix rule dropped those, so reconnecting waited for
 *    SSE replay instead of hydrating the card immediately.
 *
 * A *deeper* observed namespace's own deepest segment is NOT promoted
 * unless it is itself an ancestor of something deeper — otherwise a plain
 * inner node (e.g. `worker:<uuid>|inner:<uuid>`) would surface as a
 * spurious subgraph card that was never present during live streaming.
 *
 * Tool/subagent namespaces (`tools:` / `task:`) are excluded — those are
 * owned by {@link ./subagents}. A namespace nested under a subgraph (e.g.
 * `research:<uuid>|tools:<uuid>`) still promotes its non-internal
 * `research:<uuid>` ancestor.
 */
export function collectSubgraphHostNamespaces(
  history: AnyCheckpoint[]
): SubgraphHost[] {
  // Directly observed namespace tuples (state + task checkpoint_ns), with
  // NO prefix synthesis — host promotion is derived below so that a deeper
  // namespace's leaf segment is not mistaken for a host.
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

  // Host candidates = strict ancestors of observed (interior) + depth-1
  // observed (top-level). Insertion order: shallow ancestors first so the
  // emitted host list keeps parents ahead of children.
  const candidates = new Map<string, string[]>();
  for (const segments of observed.values()) {
    for (let depth = 1; depth < segments.length; depth += 1) {
      const slice = segments.slice(0, depth);
      candidates.set(namespaceKey(slice), slice);
    }
    if (segments.length === 1) {
      candidates.set(namespaceKey(segments), segments);
    }
  }

  const hosts: SubgraphHost[] = [];
  for (const [key, segments] of candidates) {
    if (segments.some(isInternalSegment)) continue;
    const prefix = key + NAMESPACE_SEPARATOR;
    const running =
      pending.has(key) || [...pending].some((p) => p.startsWith(prefix));
    hosts.push({
      namespace: segments,
      status: running ? "running" : "complete",
    });
  }
  return hosts;
}
