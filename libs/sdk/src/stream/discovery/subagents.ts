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
import type {
  Event,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import { StreamStore } from "../store.js";
import type { SubagentDiscoverySnapshot } from "../types.js";

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

    let changed = false;
    for (const message of messages) {
      for (const toolCall of getTaskToolCalls(message)) {
        const before = this.#map.get(toolCall.id);
        this.#upsertTaskToolCall(toolCall.id, toolCall.input, event.params.namespace);
        if (this.#map.get(toolCall.id) !== before) changed = true;
      }
    }
    if (changed) this.#commit();
  }

  #upsertTaskToolCall(
    toolCallId: string,
    input: { description?: string; subagent_type?: string },
    eventNamespace: readonly string[]
  ): void {
    const existing = this.#map.get(toolCallId);
    if (existing != null) {
      existing.name = input.subagent_type ?? existing.name;
      existing.taskInput = input.description ?? existing.taskInput;
      if (existing.status !== "complete" && existing.status !== "error") {
        existing.status = "running";
      }
      return;
    }

    // The subagent's OWN events (its instruction human message, its
    // model_request subgraph, its own tool calls) are emitted under
    // `["tools:<toolCallId>"]`, NOT under the dispatcher namespace this
    // `task` call was observed on. Record the subagent's work namespace
    // so `useMessages(stream, subagent)` / `useToolCalls(stream,
    // subagent)` open the right subscription.
    const namespace: readonly string[] = [`tools:${toolCallId}`];
    const { parentId, depth } = lineageFromNamespace(eventNamespace);
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
  }
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
  if (message == null || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) return [];

  const result: Array<{
    id: string;
    input: { description?: string; subagent_type?: string };
  }> = [];
  for (const toolCall of toolCalls) {
    if (toolCall == null || typeof toolCall !== "object" || Array.isArray(toolCall)) {
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
  if (namespace.length === 0) return { parentId: null, depth: 1 };
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
