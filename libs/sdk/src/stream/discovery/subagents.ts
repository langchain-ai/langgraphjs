/**
 * Root-scoped subagent discovery.
 *
 * Populates a `Map<callId, SubagentDiscoverySnapshot>` by watching
 * `task` tool calls on the root subscription. No content channels
 * (subagent messages, tool calls, extensions) are opened here — that
 * layer is driven by selector hooks via the
 * {@link ChannelRegistry}, keyed on `SubagentDiscoverySnapshot.namespace`.
 *
 * Discovery data this runner populates per subagent:
 *   - id, name, namespace, parentId, depth
 *   - status (`running` | `complete` | `error`)
 *   - taskInput / output / error / startedAt / completedAt
 *
 * The runner is fed events by the {@link StreamController}'s root
 * subscription; it does not open subscriptions of its own.
 */
import type { Event, ToolsEvent, ValuesEvent } from "@langchain/protocol";
import { StreamStore } from "../store.js";
import type { SubagentDiscoverySnapshot } from "../types.js";
import {
  isConcreteToolNamespace,
  isRootNamespace,
  isToolNamespaceSegment,
  namespaceKey,
} from "../namespace.js";

export type SubagentMap = ReadonlyMap<string, SubagentDiscoverySnapshot>;

interface MutableSubagent {
  id: string;
  name: string;
  namespace: readonly string[];
  parentId: string | null;
  depth: number;
  status: "running" | "complete" | "error";
  taskInput: string | undefined;
  output: unknown;
  error: string | undefined;
  startedAt: Date;
  completedAt: Date | null;
}

export class SubagentDiscovery {
  readonly store = new StreamStore<SubagentMap>(new Map());
  #map = new Map<string, MutableSubagent>();
  #taskIdByObservedNamespace = new Map<string, string>();
  #observedOwnNamespaces = new Set<string>();

  /** Feed a single root event. Non-discovery events are ignored. */
  push(event: Event): void {
    if (event.method === "tools") {
      this.#onToolEvent(event as ToolsEvent);
    } else if (event.method === "values") {
      this.#onValuesEvent(event as ValuesEvent);
    }
  }

  /** Current snapshot map. */
  get snapshot(): SubagentMap {
    return this.store.getSnapshot();
  }

  discoverFromMessage(message: unknown, namespace: readonly string[]): void {
    let changed = false;
    for (const toolCall of getTaskToolCalls(message)) {
      changed =
        this.#upsertTaskToolCall(toolCall.id, toolCall.input, namespace) ||
        changed;
    }
    if (changed) this.#commit();
  }

  #commit(): void {
    // Rebuild as a fresh Map so React / useSyncExternalStore sees a
    // new reference on every change.
    this.store.setValue(
      new Map(
        [...this.#map.values()].map((entry) => [entry.id, toSnapshot(entry)])
      )
    );
  }

  #onToolEvent(event: ToolsEvent): void {
    const data = event.params.data;
    const toolCallId = (data as { tool_call_id?: string }).tool_call_id;
    const toolName = (data as { tool_name?: string }).tool_name;

    if (data.event === "tool-started" && toolName === "task") {
      const input = parseTaskInput((data as { input?: unknown }).input);
      if (toolCallId == null) return;
      this.#upsertTaskToolCall(toolCallId, input, event.params.namespace);
      this.#commit();
      return;
    }

    if (toolCallId == null) return;
    const entry = this.#map.get(toolCallId);
    if (entry == null) return;

    if (data.event === "tool-finished") {
      entry.status = "complete";
      entry.output = (data as { output?: unknown }).output;
      entry.completedAt = new Date();
      this.#commit();
      return;
    }

    if (data.event === "tool-error") {
      entry.status = "error";
      entry.error = (data as { message?: string }).message ?? "Subagent failed";
      entry.completedAt = new Date();
      this.#commit();
    }
  }

  #onValuesEvent(event: ValuesEvent): void {
    const data = event.params.data;
    if (data == null || typeof data !== "object" || Array.isArray(data)) return;
    const messages = (data as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return;

    let changed = this.#recordObservedWorkNamespace(event.params.namespace);
    for (const message of messages) {
      for (const toolCall of getTaskToolCalls(message)) {
        changed =
          this.#upsertTaskToolCall(
            toolCall.id,
            toolCall.input,
            event.params.namespace
          ) || changed;
      }

      const toolCallId = getToolMessageCallId(message);
      if (toolCallId == null) continue;
      const existing = this.#map.get(toolCallId);
      if (existing == null) continue;
      existing.status = "complete";
      existing.output = message;
      existing.completedAt = new Date();
      changed = true;
    }
    if (changed) this.#commit();
  }

  #upsertTaskToolCall(
    toolCallId: string,
    input: { description?: string; subagent_type?: string },
    eventNamespace: readonly string[]
  ): boolean {
    const namespace = taskWorkNamespace(toolCallId, eventNamespace);
    const existing = this.#map.get(toolCallId);
    if (existing != null) {
      let changed = false;
      this.#recordTaskNamespaceCandidate(toolCallId, eventNamespace);
      const nextName = input.subagent_type ?? existing.name;
      const nextTaskInput = input.description ?? existing.taskInput;
      if (existing.name !== nextName) {
        existing.name = nextName;
        changed = true;
      }
      if (existing.taskInput !== nextTaskInput) {
        existing.taskInput = nextTaskInput;
        changed = true;
      }
      const namespaceKeyed = namespaceKey(existing.namespace);
      const ownNamespaceKey = `tools:${toolCallId}`;
      const nextNamespaceKey = namespaceKey(namespace);
      if (
        isConcreteToolNamespace(eventNamespace) ||
        namespaceKeyed === ownNamespaceKey
      ) {
        // A wrapper task tool event can arrive under an execution namespace
        // like `tools:<uuid>`, while the subagent's actual message state is
        // under `tools:<tool_call_id>`. Once discovery has observed the own
        // namespace carrying state, do not demote it back to the wrapper
        // namespace.
        if (
          namespaceKeyed === ownNamespaceKey &&
          nextNamespaceKey !== ownNamespaceKey &&
          this.#observedOwnNamespaces.has(toolCallId)
        ) {
          return changed;
        }
        if (namespaceKeyed !== nextNamespaceKey) {
          existing.namespace = namespace;
          changed = true;
        }
      }
      if (existing.status !== "complete" && existing.status !== "error") {
        if (existing.status !== "running") {
          existing.status = "running";
          changed = true;
        }
      }
      return changed;
    }

    // Prefer the namespace where the task is first observed. Later
    // observations may move it between wrapper execution namespaces
    // and `["tools:<toolCallId>"]`, depending on where the stream proves
    // the worker's scoped message/tool state exists.
    const { parentId, depth } = lineageFromNamespace(eventNamespace);
    this.#recordTaskNamespaceCandidate(toolCallId, eventNamespace);
    this.#map.set(toolCallId, {
      id: toolCallId,
      name: input.subagent_type ?? "unknown",
      namespace,
      parentId,
      depth,
      status: "running",
      taskInput: input.description,
      output: undefined,
      error: undefined,
      startedAt: new Date(),
      completedAt: null,
    });
    return true;
  }

  #recordObservedWorkNamespace(namespace: readonly string[]): boolean {
    if (!isConcreteToolNamespace(namespace)) return false;
    const last = namespace.at(-1);
    if (last == null) return false;
    const namespaceKeyed = namespaceKey(namespace);
    const toolCallId =
      this.#taskIdByObservedNamespace.get(namespaceKeyed) ??
      last.slice("tools:".length);
    const existing = this.#map.get(toolCallId);
    if (existing == null) return false;

    const ownNamespaceKey = `tools:${toolCallId}`;
    if (namespaceKeyed === ownNamespaceKey) {
      this.#observedOwnNamespaces.add(toolCallId);
    } else if (
      this.#observedOwnNamespaces.has(toolCallId) ||
      (!this.#taskIdByObservedNamespace.has(namespaceKeyed) &&
        !shouldPromoteToObservedNamespace(existing))
    ) {
      return false;
    }

    if (namespaceKey(existing.namespace) === namespaceKeyed) return false;
    existing.namespace = [...namespace];
    return true;
  }

  #recordTaskNamespaceCandidate(
    toolCallId: string,
    namespace: readonly string[]
  ): void {
    if (!isConcreteToolNamespace(namespace)) return;
    this.#taskIdByObservedNamespace.set(namespaceKey(namespace), toolCallId);
  }
}

function shouldPromoteToObservedNamespace(entry: MutableSubagent): boolean {
  return (
    entry.name === "fanout-worker" ||
    /^Worker worker-\d+/i.test(entry.taskInput ?? "")
  );
}

function taskWorkNamespace(
  toolCallId: string,
  eventNamespace: readonly string[]
): readonly string[] {
  const last = eventNamespace.at(-1);
  if (last != null && isToolNamespaceSegment(last)) return [...eventNamespace];
  return [`tools:${toolCallId}`];
}

function toSnapshot(entry: MutableSubagent): SubagentDiscoverySnapshot {
  return {
    id: entry.id,
    name: entry.name,
    namespace: entry.namespace,
    parentId: entry.parentId,
    depth: entry.depth,
    status: entry.status,
    taskInput: entry.taskInput,
    output: entry.output,
    error: entry.error,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
}

function parseTaskInput(raw: unknown): {
  description?: string;
  subagent_type?: string;
} {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        description:
          typeof parsed.description === "string"
            ? parsed.description
            : undefined,
        subagent_type:
          typeof parsed.subagent_type === "string"
            ? parsed.subagent_type
            : undefined,
      };
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      subagent_type:
        typeof obj.subagent_type === "string" ? obj.subagent_type : undefined,
    };
  }
  return {};
}

function getTaskToolCalls(message: unknown): Array<{
  id: string;
  input: { description?: string; subagent_type?: string };
}> {
  if (
    message == null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return [];
  }
  const record = message as {
    tool_calls?: unknown;
    kwargs?: { tool_calls?: unknown };
    lc_kwargs?: { tool_calls?: unknown };
  };
  const toolCalls =
    record.tool_calls ??
    record.kwargs?.tool_calls ??
    record.lc_kwargs?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];

  const result: Array<{
    id: string;
    input: { description?: string; subagent_type?: string };
  }> = [];
  for (const toolCall of toolCalls) {
    if (
      toolCall == null ||
      typeof toolCall !== "object" ||
      Array.isArray(toolCall)
    ) {
      continue;
    }
    const record = toolCall as {
      id?: unknown;
      name?: unknown;
      args?: unknown;
    };
    if (typeof record.id !== "string" || record.name !== "task") continue;
    result.push({ id: record.id, input: parseTaskInput(record.args) });
  }
  return result;
}

function getToolMessageCallId(message: unknown): string | undefined {
  if (
    message == null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return undefined;
  }
  const record = message as {
    tool_call_id?: unknown;
    kwargs?: { tool_call_id?: unknown };
    lc_kwargs?: { tool_call_id?: unknown };
  };
  const id =
    record.tool_call_id ??
    record.kwargs?.tool_call_id ??
    record.lc_kwargs?.tool_call_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Derive (parentId, depth) from a namespace like
 * `["subagents:abc:def"]`. Namespaces form a rooted tree; the last
 * `:` segment of the deepest namespace element is the current node's
 * call-id and the one before it is the parent.
 */
function lineageFromNamespace(namespace: readonly string[]): {
  parentId: string | null;
  depth: number;
} {
  if (isRootNamespace(namespace)) return { parentId: null, depth: 1 };
  const last = namespace[namespace.length - 1];
  if (last == null) return { parentId: null, depth: 1 };
  // Namespace segments typically look like
  //   subagents:<parentCallId>:<thisCallId>
  // but the protocol doesn't mandate that shape; we best-effort.
  const parts = last.split(":").filter((part) => part.length > 0);
  const trimmed = parts.slice(1); // drop the leading "subagents" prefix
  const depth = Math.max(1, trimmed.length);
  const parentId = trimmed.length >= 2 ? trimmed[trimmed.length - 2] : null;
  return { parentId: parentId ?? null, depth };
}
