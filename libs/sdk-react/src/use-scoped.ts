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
 * A subagent whose namespace isn't known yet: `useStream` shows such a
 * subagent at `["tools:<tool call id>"]`, and a target with that namespace,
 * given as the subagent or alone, stands for it.
 */
function unresolvedSubagent(
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
  const subagent = stream.subagents.get(id);
  return subagent?.namespace.join("|") === namespace[0] ? subagent : undefined;
}

/**
 * What identifies a target's scope, `undefined` for the main conversation. An
 * unresolved subagent's key changes with its status, so a lookup that found
 * nothing while it ran is made again once it ends.
 */
export function scopeKeyOf(
  stream: StreamLike,
  target: SelectorTarget
): string | undefined {
  const subagent = unresolvedSubagent(stream, target);
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
  const subagent = unresolvedSubagent(stream, target);
  return subagent == null
    ? namespaceOf(target)
    : engineOf(stream).resolveSubagentNamespace(subagent.id);
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
    | { snapshot: ScopeSnapshot; toolCalls: ToolCalls; view: ScopeView }
    | undefined;

  void resolveNamespace(stream, target).then((resolved) => {
    if (released || resolved == null) return;
    namespace = resolved;
    scope = engine.scopes.acquire(resolved);
    unsubscribe = scope.subscribe(() => {
      for (const listener of listeners) listener();
    });
    for (const listener of listeners) listener();
  });

  return {
    getSnapshot() {
      const snapshot = scope?.getSnapshot();
      if (snapshot == null) return EMPTY_VIEW;
      if (cache?.snapshot !== snapshot) {
        const toolCalls = toolCallsOf(
          snapshot.messages,
          namespace,
          cache?.toolCalls
        );
        cache = {
          snapshot,
          toolCalls,
          view: {
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
