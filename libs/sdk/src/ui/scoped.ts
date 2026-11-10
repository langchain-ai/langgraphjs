import type { BaseMessage } from "@langchain/core/messages";

import type { Client } from "../client.js";
import { inNamespaces } from "../client/runs/namespaces.js";
import type { Message } from "../types.messages.js";
import type { StreamReconnectOptions } from "../utils/stream.js";
import { MessageTupleManager, ensureMessageInstances } from "./messages.js";

/** What a scope's panel shows of its subgraph. */
export interface ScopeSnapshot {
  /** Its messages, as `BaseMessage` instances. */
  readonly messages: BaseMessage[];
  /** Its latest `values` event. */
  readonly values: Record<string, unknown> | undefined;
}

/** A held scope. Its subgraph streams while any holder hasn't released it. */
export interface Scope {
  getSnapshot(): ScopeSnapshot;
  subscribe(listener: () => void): () => void;
  release(): void;
}

/** What {@link ScopeRegistry} needs from its engine. */
export interface ScopeHost {
  client(): Client;
  threadId(): string | undefined;
  messagesKey(): string;
  reconnectOptions(): StreamReconnectOptions;
  /** Whether the server filters a join by namespace (`stream_namespaces`). */
  canFilter(): Promise<boolean>;
  /** Ids of the messages the main conversation shows. */
  rootMessageIds(): Set<string>;
  /** Whether the subagent at this namespace ran to its end. */
  finished(namespace: string): boolean;
  /** Called with each join event the run's own stream doesn't carry. */
  onEvent(event: string, data: unknown): void;
}

const MAX_OPEN_STREAMS = 4;
let openStreams = 0;
const waiting: Array<() => void> = [];

/**
 * Counts an open stream against the page's budget. Browsers open six
 * connections per server over HTTP/1.1 (`langgraph dev`), so at most four
 * engine streams leave room for requests such as `stop()` and `respond()`.
 *
 * @returns Its release.
 */
export function holdStream(): () => void {
  openStreams += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    openStreams -= 1;
    if (openStreams < MAX_OPEN_STREAMS) waiting.shift()?.();
  };
}

/** A held stream once fewer than four are open, or `undefined` if aborted first. */
function waitForStream(signal: AbortSignal): Promise<(() => void) | undefined> {
  if (openStreams < MAX_OPEN_STREAMS) return Promise.resolve(holdStream());
  return new Promise((resolve) => {
    const take = () => {
      signal.removeEventListener("abort", giveUp);
      resolve(holdStream());
    };
    const giveUp = () => {
      waiting.splice(waiting.indexOf(take), 1);
      resolve(undefined);
    };
    waiting.push(take);
    signal.addEventListener("abort", giveUp, { once: true });
  });
}

interface ScopeState {
  readonly key: string;
  readonly keeps: (part: { event: string; data: unknown }) => boolean;
  refs: number;
  messages: MessageTupleManager;
  list: BaseMessage[];
  /** `list` at the latest `values` event, which a restarted run goes back to. */
  attemptList: BaseMessage[];
  values: Record<string, unknown> | undefined;
  /** Ids of the run's events already applied, since a reopened join replays. */
  seen: Set<string>;
  snapshot: ScopeSnapshot;
  listeners: Set<() => void>;
  notifying: boolean;
}

const EMPTY: ScopeSnapshot = { messages: [], values: undefined };

/**
 * Ref-counted scopes of a run's subgraphs, such as subagent panels. All held
 * scopes share one join of the running run, from its start, filtered to
 * their namespaces where the server can. A scope released by every holder
 * drops its data.
 */
export class ScopeRegistry {
  readonly #host: ScopeHost;

  #scopes = new Map<string, ScopeState>();

  #run:
    | { id: string; subgraphs: boolean; filtered: boolean; ended: boolean }
    | undefined;

  #join: AbortController | undefined;

  #reopening = false;

  /** Event ids handed to the channels, since a reopened join replays. */
  #emitted = new Set<string>();

  /** A thread whose server can't read a subgraph's history. */
  #historyRefused: string | undefined;

  #disposed = false;

  constructor(host: ScopeHost) {
    this.#host = host;
  }

  /**
   * Hold the scope of a namespace, such as a subagent's `["tools:<id>"]`.
   * A subagent that no run streams now is read from the thread's history.
   */
  acquire(namespace: readonly string[]): Scope {
    const key = namespace.join("|");
    let scope = this.#scopes.get(key);
    if (scope == null) {
      scope = {
        key,
        keeps: inNamespaces([key])!,
        refs: 0,
        messages: new MessageTupleManager(),
        list: [],
        attemptList: [],
        values: undefined,
        seen: new Set(),
        snapshot: EMPTY,
        listeners: new Set(),
        notifying: false,
      };
      const created = scope;
      created.messages.onRefresh = (ids) => {
        for (const id of ids) this.#place(created, id, true);
        this.#publish(created);
      };
      this.#scopes.set(key, scope);
      const run = this.#run;
      if (
        run == null ||
        run.ended ||
        !run.subgraphs ||
        this.#host.finished(key)
      ) {
        void this.#seed(scope);
      }
      this.#reopen();
    }
    scope.refs += 1;
    const held = scope;
    let released = false;
    return {
      getSnapshot: () => held.snapshot,
      subscribe: (listener) => {
        held.listeners.add(listener);
        return () => held.listeners.delete(listener);
      },
      release: () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        if (held.refs > 0 || this.#scopes.get(key) !== held) return;
        this.#scopes.delete(key);
        held.messages.clear();
        this.#reopen();
      },
    };
  }

  /**
   * The run the engine streams now, or `undefined` when none does. Without
   * `subgraphs` the run publishes no subgraph events, so it has nothing to
   * join. `filtered` says the run's own stream carries only the main
   * conversation, so the channels get the scopes' events from their join.
   */
  setRun(
    runId: string | undefined,
    mode: { subgraphs?: boolean; filtered?: boolean } = {}
  ): void {
    // A run's id can arrive after its engine is disposed.
    if (this.#disposed) return;
    const same = runId != null && runId === this.#run?.id;
    // The same run joined again after its stream ended streams again.
    if (same && !this.#run!.ended) return;
    if (!same) {
      this.#emitted.clear();
      for (const scope of this.#scopes.values()) {
        scope.seen.clear();
        scope.messages.startReplay();
      }
    }
    this.#run =
      runId == null
        ? undefined
        : {
            id: runId,
            subgraphs: mode.subgraphs ?? true,
            filtered: mode.filtered ?? false,
            ended: false,
          };
    this.#reopen();
  }

  /**
   * The run's own stream ended. A join still replaying it goes on to its end,
   * and a scope it didn't fill, or every one when the run had no subgraphs,
   * is read from history.
   */
  endRun(runId: string): void {
    const run = this.#run;
    if (run?.id !== runId || run.ended) return;
    run.ended = true;
    for (const scope of this.#scopes.values()) {
      // Nothing streamed a run without subgraphs, so a read made during it
      // is stale.
      if (!run.subgraphs || scope.values == null) {
        void this.#seed(scope, !run.subgraphs);
      }
    }
  }

  /** Drop what every scope holds, for a thread switch. */
  clear(): void {
    this.setRun(undefined);
    for (const scope of this.#scopes.values()) {
      scope.messages.clear();
      scope.list = [];
      scope.attemptList = [];
      scope.values = undefined;
      this.#publish(scope);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#run = undefined;
    this.#join?.abort();
    this.#join = undefined;
  }

  #reopen(): void {
    if (this.#reopening) return;
    this.#reopening = true;
    // Panels that open together open one join.
    queueMicrotask(() => {
      this.#reopening = false;
      const run = this.#run;
      // Scopes held after a run ended were read from history, and the join
      // still replaying it finishes for the ones it has.
      if (run?.ended && this.#scopes.size > 0) return;
      this.#join?.abort();
      this.#join = undefined;
      const threadId = this.#host.threadId();
      if (threadId == null || run == null || run.ended || !run.subgraphs) {
        return;
      }
      if (this.#scopes.size === 0) return;
      const join = new AbortController();
      this.#join = join;
      void this.#follow(
        threadId,
        run.id,
        [...this.#scopes.keys()],
        join.signal
      );
    });
  }

  async #follow(
    threadId: string,
    runId: string,
    namespaces: string[],
    signal: AbortSignal
  ): Promise<void> {
    const release = await waitForStream(signal);
    if (release == null) return;
    try {
      const filtered = await this.#host.canFilter();
      const events = this.#host.client().runs.joinStream(threadId, runId, {
        signal,
        lastEventId: "-1",
        streamNamespaces: filtered ? namespaces : undefined,
        ...this.#host.reconnectOptions(),
      });
      let sawEvent = false;
      for await (const { id, event, data } of events) {
        if (signal.aborted) break;
        if (event === "metadata" && id != null) this.#attempt(id, sawEvent);
        sawEvent = true;
        if (
          this.#route(id, event, data) &&
          this.#run?.filtered &&
          (id == null || !this.#emitted.has(id))
        ) {
          if (id != null) this.#emitted.add(id);
          this.#host.onEvent(event, data);
        }
      }
    } catch {
      // A panel keeps what it has when its join fails or is stopped.
    } finally {
      release();
    }
  }

  /**
   * Applies a join event to the scopes it belongs to, and says whether one
   * took it for the first time. Run-level events and lifecycle events are
   * the run stream's.
   */
  #route(id: string | undefined, event: string, data: unknown): boolean {
    const bar = event.indexOf("|");
    const method = bar === -1 ? event : event.slice(0, bar);
    if (method === "lifecycle" || (bar === -1 && method !== "messages")) {
      return false;
    }
    // Old JS cores name a subgraph's tokens without its namespace.
    const named =
      method === "messages" && bar === -1 ? namespaceFromMetadata(data) : event;
    let fresh = false;
    for (const scope of this.#scopes.values()) {
      if (!scope.keeps({ event: named, data })) continue;
      if (id != null && scope.seen.has(id)) continue;
      if (id != null) scope.seen.add(id);
      fresh = true;
      if (event === `values|${scope.key}`) {
        this.#setValues(scope, data as Record<string, unknown>);
        this.#publish(scope);
      } else if (method === "messages") {
        const [message, metadata] = data as [Message, Record<string, unknown>];
        const messageId = scope.messages.add(message, metadata);
        if (messageId != null) this.#place(scope, messageId, false);
        this.#publish(scope);
      }
    }
    return fresh;
  }

  #setValues(scope: ScopeState, values: Record<string, unknown>): void {
    const rootIds = this.#host.rootMessageIds();
    const messages = values?.[this.#host.messagesKey()];
    scope.values = values;
    // Deep agents' fork-mode subagents start from a copy of the parent's
    // messages.
    scope.list = ensureMessageInstances(
      Array.isArray(messages) ? messages : []
    ).filter((message) => message.id == null || !rootIds.has(message.id));
    scope.attemptList = scope.list;
  }

  /** Places a streamed message by id, as the main conversation does. */
  #place(scope: ScopeState, messageId: string, updateOnly: boolean): void {
    const chunk = scope.messages.get(messageId)?.chunk;
    if (chunk == null) return;
    const list = scope.list.slice();
    let index = list.length - 1;
    while (index >= 0 && list[index].id !== messageId) index -= 1;
    if (chunk.getType() === "remove") {
      if (index !== -1) list.splice(index, 1);
    } else if (index !== -1 || !updateOnly) {
      list[index === -1 ? list.length : index] = chunk;
    }
    scope.list = list;
  }

  /**
   * A run sends `metadata` once per attempt, so one after other events is a
   * restart: each scope that hasn't seen it goes back to its last values.
   */
  #attempt(attemptId: string, restart: boolean): void {
    for (const scope of this.#scopes.values()) {
      if (scope.seen.has(attemptId)) continue;
      scope.seen.add(attemptId);
      if (!restart) continue;
      scope.messages.startReplay();
      scope.list = scope.attemptList;
      this.#publish(scope);
    }
  }

  async #seed(scope: ScopeState, replace = false): Promise<void> {
    const threadId = this.#host.threadId();
    if (threadId == null || this.#historyRefused === threadId) return;
    try {
      const [state] = await this.#host
        .client()
        .threads.getHistory<Record<string, unknown>>(threadId, {
          checkpoint: { checkpoint_ns: scope.key },
          limit: 1,
        });
      const current = this.#scopes.get(scope.key) === scope;
      if (!current || threadId !== this.#host.threadId()) return;
      if (state?.values != null && (replace || scope.values == null)) {
        this.#setValues(scope, state.values);
        this.#publish(scope);
      }
    } catch (error) {
      // An older Python langgraph refuses a namespace no node declares, where
      // deep agents' subagents save, and logs each refusal as an error.
      if ((error as { status?: unknown } | null)?.status === 400) {
        this.#historyRefused = threadId;
      }
    }
  }

  #publish(scope: ScopeState): void {
    scope.snapshot = { messages: scope.list, values: scope.values };
    if (scope.notifying) return;
    scope.notifying = true;
    // One notification per macrotask, as the main stream's `throttle: true`.
    setTimeout(() => {
      scope.notifying = false;
      for (const listener of scope.listeners) listener();
    }, 0);
  }
}

function namespaceFromMetadata(data: unknown): string {
  const metadata = (Array.isArray(data) ? data[1] : undefined) as
    | { langgraph_checkpoint_ns?: unknown; checkpoint_ns?: unknown }
    | undefined;
  const namespace =
    metadata?.langgraph_checkpoint_ns || metadata?.checkpoint_ns;
  return typeof namespace === "string" && namespace !== ""
    ? `messages|${namespace}`
    : "messages";
}
