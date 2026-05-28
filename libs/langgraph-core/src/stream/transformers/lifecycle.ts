/**
 * LifecycleTransformer - synthesizes `lifecycle` channel events that
 * track the status of the root run and every subgraph it spawns.
 *
 * The transformer is registered first in `createGraphRunStream` so that
 * every other transformer / consumer sees a coherent, authoritative
 * lifecycle stream. It is product-agnostic: deeper semantics (e.g.
 * DeepAgents' `SubagentTransformer` tool-call causation) reach the wire
 * by way of the re-entrant {@link StreamEmitter} - the transformer
 * stashes any `cause` attached upstream and re-emits its own
 * authoritative `lifecycle.started` with the correlation in place.
 *
 * Events are also pushed to a local {@link StreamChannel} so in-process
 * consumers can iterate `run.lifecycle` without filtering the main
 * event stream.
 */

import type {
  AgentStatus,
  LifecycleCause,
  LifecycleData,
} from "@langchain/protocol";

import { hasPrefix, nsKey } from "../mux.js";
import { StreamChannel } from "../stream-channel.js";
import type {
  NativeStreamTransformer,
  Namespace,
  ProtocolEvent,
  StreamEmitter,
} from "../types.js";
import type { LifecycleEntry, LifecycleTransformerOptions } from "./types.js";

/**
 * Projection returned from the lifecycle transformer's `init()`.
 *
 * The local `StreamChannel` is closed automatically when the transformer
 * finalizes or fails. `_lifecycleLog` is intentionally underscore-prefixed to
 * signal that it is consumed by the run stream wiring
 * (see `run-stream.ts`) and not meant for direct user access -
 * consumers should read `run.lifecycle` instead.
 *
 * The `lifecycle` iterable is the root-scoped projection (prefix
 * `[]`, starting at offset `0`) mirroring the pattern used by the
 * subgraph discovery transformer.  Root stream wiring consumes it
 * via `SET_LIFECYCLE_ITERABLE`; child streams are wired with their
 * own path-scoped iterable produced by `filterLifecycleEntries`.
 */
export interface LifecycleProjection {
  _lifecycleLog: StreamChannel<LifecycleEntry>;
  lifecycle: AsyncIterable<LifecycleEntry>;
}

/**
 * Filter a lifecycle {@link StreamChannel} to only the entries whose
 * namespace lies within the subtree rooted at {@link path}.
 *
 * Returns an `AsyncIterable` whose iterator yields every entry whose
 * namespace either equals {@link path} or is a descendant of it.
 * Iteration begins at {@link startAt}, so callers can capture the
 * log's current size at construction time to skip entries emitted
 * before the caller existed (e.g. a subgraph stream discovered
 * mid-run shouldn't replay the root's `started`).
 *
 * @param log - The shared lifecycle log owned by the transformer.
 * @param path - Namespace prefix to scope entries by (use `[]` for
 *   the root subtree, i.e. everything).
 * @param startAt - Zero-based index into the log to begin from.
 * @returns An async iterable of matching lifecycle entries.
 */
export function filterLifecycleEntries(
  log: StreamChannel<LifecycleEntry>,
  path: Namespace,
  startAt = 0
): AsyncIterable<LifecycleEntry> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LifecycleEntry> {
      const base = log.iterate(startAt);
      return {
        async next(): Promise<IteratorResult<LifecycleEntry>> {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const result = await base.next();
            if (result.done) {
              return {
                value: undefined as unknown as LifecycleEntry,
                done: true,
              };
            }
            if (hasPrefix(result.value.namespace, path)) {
              return { value: result.value, done: false };
            }
          }
        },
      };
    },
  };
}

const DEFAULT_ROOT_GRAPH_NAME = "root";

function defaultGuessGraphName(ns: Namespace): string {
  if (ns.length === 0) return DEFAULT_ROOT_GRAPH_NAME;
  const last = ns[ns.length - 1];
  const colon = last.indexOf(":");
  return colon === -1 ? last : last.slice(0, colon);
}

function defaultSerializeError(err: unknown): string {
  // oxlint-disable-next-line no-instanceof/no-instanceof
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract an upstream `cause` from a `lifecycle.started` payload, if
 * the shape matches one of the known variants. Shape validation is
 * intentionally loose: any object with a string `type` is accepted, so
 * future protocol variants flow through unchanged.
 */
function extractCause(data: unknown): LifecycleCause | undefined {
  if (!isRecord(data)) return undefined;
  if (data.event !== "started") return undefined;
  const cause = data.cause;
  if (!isRecord(cause)) return undefined;
  if (typeof cause.type !== "string") return undefined;
  return cause as unknown as LifecycleCause;
}

function extractTaskResultCompletion(
  data: unknown
): TaskResultCompletion | undefined {
  if (!isRecord(data)) return undefined;
  if (!("result" in data)) return undefined;
  if (typeof data.name !== "string") return undefined;
  if (typeof data.id !== "string") return undefined;
  if (data.name.startsWith("__")) return undefined;
  return { name: data.name, id: data.id };
}

interface NamespaceRecord {
  readonly namespace: Namespace;
  readonly graphName: string;
  /** Last emitted status; `undefined` until `emit` fires for this namespace. */
  status: AgentStatus | undefined;
}

interface TaskResultCompletion {
  readonly name: string;
  readonly id: string;
}

interface PendingCompletion {
  readonly namespace: Namespace;
  readonly source:
    | { readonly type: "task" }
    | {
        readonly type: "node";
        readonly parent: Namespace;
        readonly node: string;
      };
}

/**
 * Create the built-in lifecycle transformer.
 *
 * Marked as a {@link NativeStreamTransformer} so the run stream
 * factory can expose `_lifecycleLog` via a dedicated getter
 * (`run.lifecycle`) rather than through `run.extensions`.
 */
export function createLifecycleTransformer(
  options: LifecycleTransformerOptions = {}
): NativeStreamTransformer<LifecycleProjection> {
  const rootGraphName = options.rootGraphName ?? DEFAULT_ROOT_GRAPH_NAME;
  const initialStatus: AgentStatus = options.initialStatus ?? "running";
  const emitRootOnRegister = options.emitRootOnRegister ?? true;
  const getGraphName = options.getGraphName ?? defaultGuessGraphName;
  const serializeError = options.serializeError ?? defaultSerializeError;
  const getTerminalStatusOverride = options.getTerminalStatusOverride;

  const log = StreamChannel.local<LifecycleEntry>();
  const namespaces = new Map<string, NamespaceRecord>();
  const namespaceCause = new Map<string, LifecycleCause>();
  const pendingInterruptIds = new Set<string>();
  /**
   * Child namespaces whose parent just saw an `updates` event with a
   * `node` attribution. We defer the `lifecycle.completed` emission
   * until the *next* inbound event (or `finalize`) so the parent's
   * `updates` lands on the wire before its child is marked complete -
   * matching the previous session behavior.
   */
  const pendingCompletions: PendingCompletion[] = [];

  let emitter: StreamEmitter | undefined;
  let inSelfEmit = 0;
  let finalized = false;

  const resolveGraphName = (ns: Namespace): string =>
    ns.length === 0 ? rootGraphName : getGraphName(ns);

  const emit = (
    ns: Namespace,
    status: AgentStatus,
    extras?: { cause?: LifecycleCause; error?: string }
  ): void => {
    const key = nsKey(ns);
    let current = namespaces.get(key);
    const graphName = current?.graphName ?? resolveGraphName(ns);

    // Dedup: identical status + graph name + no error override => skip.
    if (
      current != null &&
      current.status === status &&
      current.graphName === graphName &&
      extras?.error == null
    ) {
      return;
    }

    if (current == null) {
      current = { namespace: ns, graphName, status };
      namespaces.set(key, current);
    } else {
      current.status = status;
    }

    const data: LifecycleData = {
      event: status,
      graph_name: graphName,
      ...(extras?.cause != null ? { cause: extras.cause } : {}),
      ...(extras?.error != null ? { error: extras.error } : {}),
    };

    const timestamp = Date.now();

    log.push({ namespace: ns, timestamp, ...data });

    if (ns.length === 0 && !emitRootOnRegister) return;

    if (emitter == null) return;

    inSelfEmit += 1;
    try {
      emitter.push(ns, {
        type: "event",
        seq: 0,
        method: "lifecycle",
        params: { namespace: ns, timestamp, data },
      });
    } finally {
      inSelfEmit -= 1;
    }
  };

  /**
   * Ensures a record exists for `ns` without mutating its status. Used
   * by hooks that need a canonical `graphName` for lookups before emit
   * writes the first status. Status remains `undefined` until `emit`
   * fires.
   */
  const trackNamespace = (ns: Namespace): NamespaceRecord => {
    const key = nsKey(ns);
    let rec = namespaces.get(key);
    if (rec == null) {
      rec = {
        namespace: ns,
        graphName: resolveGraphName(ns),
        status: undefined,
      };
      namespaces.set(key, rec);
    }
    return rec;
  };

  const flushPendingCompletions = (): void => {
    if (pendingCompletions.length === 0) return;
    const toFlush = pendingCompletions.splice(0, pendingCompletions.length);
    for (const completion of toFlush) {
      const key = nsKey(completion.namespace);
      const rec = namespaces.get(key);
      if (rec == null || rec.status !== "started") continue;
      emit(completion.namespace, "completed");
    }
  };

  const enqueueCompletion = (completion: PendingCompletion): void => {
    const key = nsKey(completion.namespace);
    const rec = namespaces.get(key);
    if (rec == null || rec.status !== "started") return;
    if (
      pendingCompletions.some((pending) => nsKey(pending.namespace) === key)
    ) {
      return;
    }
    pendingCompletions.push(completion);
  };

  const removePendingNodeCompletions = (
    parent: Namespace,
    node: string
  ): void => {
    for (let index = pendingCompletions.length - 1; index >= 0; index -= 1) {
      const pending = pendingCompletions[index];
      if (pending.source.type !== "node") continue;
      if (pending.source.node !== node) continue;
      if (nsKey(pending.source.parent) !== nsKey(parent)) continue;
      pendingCompletions.splice(index, 1);
    }
  };

  const ensureStarted = (ns: Namespace): void => {
    // Synthesize `lifecycle.started` for each unseen prefix of `ns`,
    // outermost first. Deepest-first would force consumers to see a
    // child's started before its parent, which is wrong.
    for (let length = 1; length <= ns.length; length += 1) {
      const prefix = ns.slice(0, length);
      const key = nsKey(prefix);
      if (namespaces.has(key)) continue;
      trackNamespace(prefix);
      const cause = namespaceCause.get(key);
      emit(prefix, "started", cause != null ? { cause } : undefined);
    }
  };

  const defaultTerminalStatus = (): AgentStatus =>
    pendingInterruptIds.size > 0 ? "interrupted" : "completed";

  const cascadeTerminalStatus = (status: AgentStatus): void => {
    for (const rec of namespaces.values()) {
      if (rec.namespace.length === 0) continue;
      if (rec.status !== "started") continue;
      emit(rec.namespace, status);
    }
    emit([], status);
    log.close();
  };

  const resolveTerminalStatusOverride = async (): Promise<AgentStatus> => {
    if (getTerminalStatusOverride == null) return defaultTerminalStatus();
    try {
      return (await getTerminalStatusOverride()) ?? defaultTerminalStatus();
    } catch {
      return defaultTerminalStatus();
    }
  };

  const findStartedChildForNode = (
    parentNamespace: Namespace,
    node: string
  ): Namespace | undefined => {
    const prefix = `${node}:`;
    for (const rec of namespaces.values()) {
      if (rec.namespace.length !== parentNamespace.length + 1) continue;
      if (rec.status !== "started") continue;
      if (!hasPrefix(rec.namespace, parentNamespace)) continue;
      const last = rec.namespace[rec.namespace.length - 1];
      if (last === node || last.startsWith(prefix)) return rec.namespace;
    }
    return undefined;
  };

  const findStartedChildForTask = (
    parentNamespace: Namespace,
    task: TaskResultCompletion
  ): Namespace | undefined => {
    const namespace = [...parentNamespace, `${task.name}:${task.id}`];
    const rec = namespaces.get(nsKey(namespace));
    return rec?.status === "started" ? namespace : undefined;
  };

  const transformer: NativeStreamTransformer<LifecycleProjection> = {
    __native: true,

    init() {
      return {
        _lifecycleLog: log,
        lifecycle: filterLifecycleEntries(log, [], 0),
      };
    },

    onRegister(handle: StreamEmitter) {
      emitter = handle;
      // Seed root record so cascade logic can see it, even when the
      // outer authority owns root emission.
      trackNamespace([]);
      if (emitRootOnRegister) {
        emit([], initialStatus);
      }
    },

    process(event: ProtocolEvent): boolean {
      const ns = event.params.namespace;

      // Re-entrant loopback: an event we emitted via `emitter.push`
      // is being routed back through this transformer by the mux.
      // Allow it through the wire unchanged.
      if (inSelfEmit > 0) return true;

      const taskCompletion =
        event.method === "tasks"
          ? extractTaskResultCompletion(event.params.data)
          : undefined;
      if (taskCompletion != null) {
        // Prefer exact task-result attribution over any ambiguous
        // `updates.node` completion deferred from the previous event.
        removePendingNodeCompletions(ns, taskCompletion.name);
      }

      // Flush any completions deferred by the previous event so the
      // wire order is [triggering event] -> [deferred completed].
      flushPendingCompletions();

      // Upstream `lifecycle` events: stash any `cause` attached by a
      // product-specific transformer (e.g. deepagents' SubagentTransformer),
      // synthesize our authoritative started/... for the namespace, and
      // suppress the original so we are the single source of truth.
      if (event.method === "lifecycle") {
        const cause = extractCause(event.params.data);
        if (cause != null) {
          namespaceCause.set(nsKey(ns), cause);
        }
        ensureStarted(ns);
        return false;
      }

      // Lifecycle for parent + any unseen prefix => synthesize started.
      ensureStarted(ns);

      // Track interrupt ids so `finalize` can decide between
      // `completed` and `interrupted`.
      if (
        event.method === "input" &&
        isRecord(event.params.data) &&
        event.params.data.event === "requested"
      ) {
        const id = (event.params.data as { id?: unknown }).id;
        if (typeof id === "string") {
          pendingInterruptIds.add(id);
        }
      }

      if (taskCompletion != null) {
        const childNamespace = findStartedChildForTask(ns, taskCompletion);
        if (childNamespace != null) {
          enqueueCompletion({
            namespace: childNamespace,
            source: { type: "task" },
          });
        }
      }

      // Defer child-node completion: the `updates` event carries the
      // node attribution; the corresponding child namespace is
      // `[...ns, "<node>:<uuid>"]`. We pick the oldest still-started
      // matching child (LangGraph emits one updates per completed task
      // so repeated calls drain parallel fan-outs in order).
      if (event.method === "updates") {
        const node = event.params.node;
        if (typeof node === "string" && !node.startsWith("__")) {
          const childNamespace = findStartedChildForNode(ns, node);
          if (childNamespace != null) {
            enqueueCompletion({
              namespace: childNamespace,
              source: { type: "node", parent: ns, node },
            });
          }
        }
      }

      return true;
    },

    finalize(): void | PromiseLike<void> {
      if (finalized) return;
      finalized = true;
      flushPendingCompletions();

      if (getTerminalStatusOverride == null) {
        cascadeTerminalStatus(defaultTerminalStatus());
        return;
      }

      return resolveTerminalStatusOverride()
        .then(cascadeTerminalStatus)
        .catch((err) => {
          log.fail(err);
        });
    },

    fail(err: unknown) {
      if (finalized) return;
      finalized = true;
      const errorMessage = serializeError(err);

      // Cascade `failed` to every still-started namespace. Children
      // that had already entered a terminal state are left untouched
      // by the dedup guard in `emit`.
      for (const rec of namespaces.values()) {
        if (rec.namespace.length === 0) continue;
        if (rec.status !== "started") continue;
        emit(rec.namespace, "failed");
      }

      emit([], "failed", { error: errorMessage });
      log.fail(err);
    },
  };

  return transformer;
}
