import type { BaseMessage } from "@langchain/core/messages";
import type {
  AssembledToolCall,
  Scope,
  ScopeSnapshot,
  StreamEngine,
  SubgraphDiscoverySnapshot,
} from "@langchain/langgraph-sdk/ui";
import {
  STREAM_CONTROLLER,
  bindingOf,
  mayAnswer,
  toolCallsOf,
  type AnyStream,
  type ToolCalls,
} from "./use-stream.js";
import type { AnySuspenseStream } from "./suspense-stream.js";
import type { SubagentDiscoverySnapshot } from "./types.js";

/**
 * A stream from `useStream` or `useSuspenseStream`, as the selector hooks
 * take it, also for a helper component that passes one on.
 */
export type StreamLike = AnyStream | AnySuspenseStream;

/**
 * What a selector hook reads: the main conversation (none, or `[]`), a
 * subagent or subgraph from `stream.subagents` or `stream.subgraphs`, or a
 * namespace.
 */
export type SelectorTarget =
  | undefined
  | null
  | readonly string[]
  | { namespace: readonly string[] }
  | SubagentDiscoverySnapshot
  | SubgraphDiscoverySnapshot;

/** What a scope shows. */
export interface ScopeView {
  readonly messages: BaseMessage[];
  readonly toolCalls: AssembledToolCall[];
  readonly values: Record<string, unknown> | undefined;
}

/** A held view of a target's messages, tool calls and values. */
export interface ScopeHandle {
  getSnapshot(): ScopeView;
  subscribe(listener: () => void): () => void;
  /** Stop holding the view, so its connection can close. */
  release(): void;
}

export const EMPTY_VIEW: ScopeView = {
  messages: [],
  toolCalls: [],
  values: undefined,
};

/** The engine behind a stream, with a clear error for anything else. */
export function engineOf(stream: StreamLike): StreamEngine {
  const engine = (stream as Partial<StreamLike> | null | undefined)?.[
    STREAM_CONTROLLER
  ];
  if (engine == null) {
    throw new Error(
      "@langchain/react: pass the selector hooks the result of useStream or useSuspenseStream."
    );
  }
  return engine;
}

export function namespaceOf(target: SelectorTarget): readonly string[] {
  if (target == null) return [];
  return Array.isArray(target)
    ? target
    : (target as { namespace: readonly string[] }).namespace;
}

/**
 * The subagent a target at `["tools:<tool call id>"]` stands for: `useStream`
 * shows a subagent there until its namespace is known, and an app may keep
 * that namespace after. Given alone, it stands for one of the stream's
 * subagents.
 */
function placeholderSubagent(
  stream: StreamLike,
  target: SelectorTarget
): SubagentDiscoverySnapshot | undefined {
  const namespace = namespaceOf(target);
  if (namespace.length !== 1 || !namespace[0].startsWith("tools:")) {
    return undefined;
  }
  const id = namespace[0].slice("tools:".length);
  if (typeof (target as { id?: unknown }).id === "string") {
    const subagent = target as SubagentDiscoverySnapshot;
    return subagent.id === id ? subagent : undefined;
  }
  return stream.subagents.get(id);
}

/**
 * What identifies a target's scope, `undefined` for the main conversation. A
 * placeholder's key changes with its subagent's status, so a lookup that found
 * nothing while it ran is made again once it ends.
 */
export function scopeKeyOf(
  stream: StreamLike,
  target: SelectorTarget
): string | undefined {
  const subagent = placeholderSubagent(stream, target);
  if (subagent != null) return `subagent:${subagent.id}:${subagent.status}`;
  const namespace = namespaceOf(target);
  return namespace.length === 0 ? undefined : namespace.join("|");
}

/**
 * Releases a held scope a tick later, so the hook's next target, which may
 * hold the same scope (a subagent seen again with its namespace found), takes
 * it over instead of dropping and reading it again.
 */
export function releaseLater(release: () => void): void {
  setTimeout(release, 0);
}

/** The target's namespace, looked up first for a subagent after a reload. */
export async function resolveNamespace(
  stream: StreamLike,
  target: SelectorTarget
): Promise<readonly string[] | undefined> {
  const subagent = placeholderSubagent(stream, target);
  return subagent == null
    ? namespaceOf(target)
    : engineOf(stream).resolveSubagentNamespace(subagent.id);
}

/**
 * Whether a run may still answer the tool calls at `namespace`. A subagent's
 * only while the main conversation's `task` call that started it, or the
 * subagent it's nested in, is running: the subagent at the namespace's first
 * `tools:` segment. Until that subagent's namespace is known, or when its
 * `task` call isn't in the main conversation, the thread's.
 */
function scopeRunning(
  engine: StreamEngine,
  namespace: readonly string[]
): boolean {
  const stream = bindingOf(engine).getSnapshot() as AnyStream;
  const end = namespace.findIndex((segment) => segment.startsWith("tools:"));
  const key = namespace.slice(0, end + 1).join("|");
  const subagent =
    end < 0
      ? undefined
      : [...stream.subagents.values()].find(
          (candidate) => candidate.namespace.join("|") === key
        );
  const task =
    subagent && stream.toolCalls.find((call) => call.callId === subagent.id);
  return task == null ? mayAnswer(engine) : task.status === "running";
}

function rootScope(engine: StreamEngine): ScopeHandle {
  const binding = bindingOf(engine);
  let cache: { stream: AnyStream; view: ScopeView } | undefined;
  return {
    getSnapshot() {
      const stream = binding.getSnapshot() as AnyStream;
      if (cache?.stream !== stream) {
        cache = {
          stream,
          view: {
            messages: stream.messages,
            toolCalls: stream.toolCalls,
            values: stream.values as Record<string, unknown>,
          },
        };
      }
      return cache.view;
    },
    subscribe: binding.subscribe,
    release() {},
  };
}

/**
 * Hold the view of a target, for code that can't call hooks in a loop, such
 * as an adapter. A subagent's or subgraph's events stream to it while held.
 * Call `release()` when done.
 */
export function subscribeScope(
  stream: StreamLike,
  target: SelectorTarget
): ScopeHandle {
  const engine = engineOf(stream);
  if (scopeKeyOf(stream, target) == null) return rootScope(engine);

  const listeners = new Set<() => void>();
  let scope: Scope | undefined;
  let namespace: readonly string[] = [];
  let unsubscribe: (() => void) | undefined;
  let released = false;
  let cache:
    | {
        snapshot: ScopeSnapshot;
        running: boolean;
        toolCalls: ToolCalls;
        view: ScopeView;
      }
    | undefined;

  void resolveNamespace(stream, target).then((resolved) => {
    if (released || resolved == null) return;
    namespace = resolved;
    scope = engine.scopes.acquire(resolved);
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const unsubscribeScope = scope.subscribe(notify);
    // The scope's own state doesn't change when a run starts or ends.
    let wasRunning = scopeRunning(engine, namespace);
    const unsubscribeEngine = engine.subscribe(() => {
      const running = scopeRunning(engine, namespace);
      if (running === wasRunning) return;
      wasRunning = running;
      notify();
    });
    unsubscribe = () => {
      unsubscribeScope();
      unsubscribeEngine();
    };
    notify();
  });

  return {
    getSnapshot() {
      const snapshot = scope?.getSnapshot();
      if (snapshot == null) return EMPTY_VIEW;
      const running = scopeRunning(engine, namespace);
      if (cache?.snapshot !== snapshot || cache.running !== running) {
        const toolCalls = toolCallsOf(
          snapshot.messages,
          namespace,
          running,
          undefined,
          cache?.toolCalls
        );
        cache = {
          snapshot,
          running,
          toolCalls,
          view:
            cache?.snapshot === snapshot &&
            cache.toolCalls.toolCalls === toolCalls.toolCalls
              ? cache.view
              : {
                  messages: snapshot.messages,
                  toolCalls: toolCalls.toolCalls,
                  values: snapshot.values,
                },
        };
      }
      return cache.view;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    release() {
      if (released) return;
      released = true;
      unsubscribe?.();
      scope?.release();
    },
  };
}
