/**
 * Per-message checkpoint metadata projection.
 *
 * # What this module is
 *
 * The protocol emits a `checkpoints` event immediately *before* its
 * companion `values` event for the same superstep:
 *
 *   1. `checkpoints` — `{ id, parent_id?, step?, source? }`
 *   2. `values`      — `{ messages, ... }`  (same namespace)
 *
 * Both events carry the same `seq` ordering but live on different
 * channels, so the controller can't atomically observe them. This
 * tracker bridges the gap by buffering each `checkpoints` envelope
 * keyed on its namespace, then consuming it when the matching values
 * payload arrives. Once paired, the consumer (typically the
 * controller) writes a {@link MessageMetadata} record under each
 * message id.
 *
 * # Why fork / edit flows need this
 *
 * Surfacing `parentCheckpointId` per-message lets UI flows like
 * "edit a message and re-run" call
 * `submit(input, { forkFrom: checkpointId })` without making the
 * caller juggle thread state. Each message remembers the checkpoint
 * it was first observed at, so a "fork from this message" UI can read
 * `useMessageMetadata(stream, msg.id)` directly.
 *
 * # Lifecycle
 *
 *   - `bufferCheckpoint(ns, data)` — store the envelope until the
 *     companion values event arrives.
 *   - `consumeCheckpoint(ns)`      — read-and-clear the envelope when
 *     the values event lands. Returning `undefined` signals "no
 *     metadata to attach" — older snapshots without a paired
 *     checkpoint are still applied to the store, just without
 *     `parentCheckpointId`.
 *   - `recordMessages(msgs, meta)` — keep the first parent recorded
 *     for each of the supplied message ids.
 *   - `reset()`                    — clear everything (called on
 *     thread rebind / dispose).
 *
 * The buffer is read-and-cleared on consumption so a values event that
 * arrives without a fresh checkpoint envelope doesn't reuse stale
 * metadata from a previous superstep.
 */
import type { ThreadState, ThreadStateSelectField } from "../schema.js";
import { StreamStore } from "./store.js";
import { namespaceKey } from "./namespace.js";

/**
 * Optimistic lifecycle status for a message that originated from a
 * local {@link StreamController.submit} before the server echoed it.
 *
 *   - `"pending"` — applied optimistically; the run is in flight and
 *     the server has not yet echoed this id in a `values` snapshot.
 *   - `"sent"`    — the server echoed the id (run progressed); the
 *     message is now server-authoritative.
 *   - `"failed"`  — the run failed before the id was echoed. The
 *     message is kept (so UIs can show it with a retry affordance) but
 *     is dropped on the next {@link StreamController.hydrate} because
 *     it was never persisted server-side.
 *
 * Server-originated messages (history, streamed assistant turns) never
 * carry a status — `undefined` means "not optimistic".
 */
export type OptimisticStatus = "pending" | "sent" | "failed";

/**
 * Metadata tracked per message id. Surfaced to applications via
 * `useMessageMetadata(stream, messageId)`.
 */
export interface MessageMetadata {
  /**
   * Checkpoint id the message's *parent* was at when this message was
   * observed. Drives fork / edit flows
   * (`submit(input, { forkFrom: checkpointId })`).
   *
   * `undefined` when the message was observed without a paired
   * checkpoint envelope (e.g. before checkpoints rolled out, or when
   * the caller stripped them upstream).
   */
  readonly parentCheckpointId: string | undefined;

  /**
   * Optimistic lifecycle status, present only for messages applied
   * locally by an optimistic `submit()`. `undefined` for ordinary
   * server-originated messages. See {@link OptimisticStatus}.
   */
  readonly optimisticStatus?: OptimisticStatus;
}

/**
 * Read-only map exposed via {@link MessageMetadataTracker.store}.
 */
export type MessageMetadataMap = ReadonlyMap<string, MessageMetadata>;

/**
 * Lightweight envelope mirroring the on-wire `checkpoints` event.
 *
 * The protocol payload may include additional fields (`step`,
 * `source`, etc.) — we only carry what the per-message metadata
 * actually needs.
 */
export interface CheckpointEnvelope {
  /** Checkpoint id this superstep wrote. */
  readonly id: string;
  /**
   * Parent checkpoint id, when present. Becomes
   * {@link MessageMetadata.parentCheckpointId} on the next values event.
   */
  readonly parent_id?: string;
  /**
   * Monotonic superstep counter for the checkpoint. Used by the root
   * message projection to distinguish a fresh/live `values` snapshot
   * from an older one replayed by the content pump on reconnect, so a
   * stale replay can't remove tail messages the authoritative
   * `getState()` seed already established.
   */
  readonly step?: number;
}

/**
 * Frozen empty map used as the store's initial value. Keeping the
 * reference stable avoids spurious `setSnapshot` notifications on
 * `reset()` for consumers that haven't observed any metadata yet.
 */
const EMPTY_METADATA_MAP: MessageMetadataMap = new Map();

/**
 * Tracks checkpoint-derived metadata for messages.
 *
 * Owns one {@link StreamStore} mapping `messageId → MessageMetadata`
 * plus a per-namespace buffer of pending checkpoint envelopes. The
 * controller wires it up via three call sites:
 *
 *   1. `controller.#onRootEvent("checkpoints")`
 *      → `bufferCheckpoint(namespace, data)`
 *   2. `controller.#onRootEvent("values")`
 *      → `consumeCheckpoint(namespace)` then
 *      `recordMessages(values.messages, { parentCheckpointId })`
 *   3. `controller.#teardownThread`
 *      → `reset()`
 *
 * @see useMessageMetadata - The framework hook that reads from
 *   {@link MessageMetadataTracker.store}.
 */
export class MessageMetadataTracker {
  /** Observable map of messageId → metadata for framework consumers. */
  readonly store = new StreamStore<MessageMetadataMap>(EMPTY_METADATA_MAP);

  /**
   * Pending checkpoint envelopes awaiting their companion values
   * event. Keyed by `namespaceKey(namespace)` so a deeply-nested
   * checkpoint at one namespace doesn't collide with a root-level
   * checkpoint emitted in the same tick.
   */
  readonly #pendingCheckpointByNamespace = new Map<
    string,
    CheckpointEnvelope
  >();

  /**
   * Ids of messages currently in the `"pending"` optimistic state.
   * Maintained alongside the metadata map so the controller can cheaply
   * (a) flip ids to `"sent"` when the server echoes them and (b) flip
   * any leftover ids to `"sent"` / `"failed"` at run terminal, without
   * scanning the whole metadata map.
   */
  readonly #pendingOptimisticIds = new Set<string>();

  /**
   * Drop all buffered checkpoints and reset the metadata map to the
   * shared empty instance. Called on thread rebind / dispose so a new
   * thread's metadata can't bleed into the old one.
   */
  reset(): void {
    this.#pendingCheckpointByNamespace.clear();
    this.#pendingOptimisticIds.clear();
    this.store.setState(() => EMPTY_METADATA_MAP);
  }

  /**
   * Buffer a `checkpoints` event for later pairing with its values
   * companion.
   *
   * Defensive against missing / malformed payloads:
   *
   *   - `data == null`     → no-op (some upstream nodes elide the
   *     payload entirely; we keep the previous buffered envelope so
   *     the next consume call still wins).
   *   - `id` not a string  → no-op.
   *   - `parent_id` not a string → omitted from the envelope.
   *
   * @param namespace - Event namespace (used as the buffer key).
   * @param data      - Raw checkpoints payload.
   */
  bufferCheckpoint(
    namespace: readonly string[],
    data: { id?: unknown; parent_id?: unknown; step?: unknown } | null
  ): void {
    if (data == null || typeof data.id !== "string") return;
    const envelope: CheckpointEnvelope = { id: data.id };
    if (typeof data.parent_id === "string") {
      (envelope as { parent_id?: string }).parent_id = data.parent_id;
    }
    if (typeof data.step === "number") {
      (envelope as { step?: number }).step = data.step;
    }
    this.#pendingCheckpointByNamespace.set(namespaceKey(namespace), envelope);
  }

  /**
   * Read-and-clear the buffered checkpoint envelope for `namespace`.
   *
   * Always pairs with a single {@link bufferCheckpoint} call: a values
   * event without a matching buffered checkpoint returns `undefined`
   * (meaning "no metadata to attach"), and the next checkpoint event
   * starts fresh rather than reusing stale data.
   *
   * @param namespace - Event namespace to consume.
   * @returns The buffered envelope, or `undefined` when none was buffered.
   */
  consumeCheckpoint(
    namespace: readonly string[]
  ): CheckpointEnvelope | undefined {
    const key = namespaceKey(namespace);
    const checkpoint = this.#pendingCheckpointByNamespace.get(key);
    if (checkpoint != null) this.#pendingCheckpointByNamespace.delete(key);
    return checkpoint;
  }

  /**
   * Record metadata for a list of messages.
   *
   * Keeps the first `parentCheckpointId` recorded for each message,
   * because the parent of the first checkpoint that carried a message
   * is the fork point for editing it. Messages without a non-empty
   * string `id` are ignored, since there's nothing to key the metadata
   * on. The store is only updated when at least one entry changed, so
   * reapplying the same values snapshot is cheap.
   *
   * @param messages - Messages from the latest values payload.
   * @param metadata - Metadata to attach (currently just
   *   `parentCheckpointId`).
   */
  recordMessages(
    messages: Array<{ id?: string }>,
    metadata: MessageMetadata
  ): void {
    const current = this.store.getSnapshot();
    let changed = false;
    const next = new Map(current);
    for (const msg of messages) {
      const id = msg?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const prev = next.get(id);
      if (prev?.parentCheckpointId != null) continue;
      next.set(id, { ...prev, ...metadata });
      changed = true;
    }
    if (changed) this.store.setState(() => next);
  }

  /**
   * Record a `parentCheckpointId` per message id in one store update,
   * keeping one already recorded, as {@link recordMessages} does.
   */
  recordForkPoints(forkPoints: ReadonlyMap<string, string>): void {
    let next: Map<string, MessageMetadata> | undefined;
    for (const [id, parentCheckpointId] of forkPoints) {
      const prev = (next ?? this.store.getSnapshot()).get(id);
      if (prev?.parentCheckpointId != null) continue;
      next ??= new Map(this.store.getSnapshot());
      next.set(id, { ...prev, parentCheckpointId });
    }
    if (next != null) this.store.setState(() => next);
  }

  /**
   * Mark a set of message ids as optimistically `"pending"`.
   *
   * Called from {@link StreamController}'s optimistic submit path right
   * after the messages are appended to the projection, so a UI can
   * render a "sending…" affordance via
   * `useMessageMetadata(stream, id).optimisticStatus`.
   *
   * @param ids - Message ids that were just applied optimistically.
   */
  markPending(ids: Iterable<string>): void {
    let changed = false;
    const next = new Map(this.store.getSnapshot());
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      this.#pendingOptimisticIds.add(id);
      const prev = next.get(id);
      if (prev?.optimisticStatus === "pending") continue;
      next.set(id, {
        parentCheckpointId: prev?.parentCheckpointId,
        ...prev,
        optimisticStatus: "pending",
      });
      changed = true;
    }
    if (changed) this.store.setState(() => next);
  }

  /**
   * Transition the given ids out of `"pending"`.
   *
   * Only ids currently tracked as pending are affected, so passing a
   * full server `values.messages` id list (to flip echoed messages to
   * `"sent"`) never stamps a status onto ordinary server messages.
   *
   * @param ids    - Candidate ids (e.g. all ids in a server snapshot,
   *   or the ids echoed by a single submit).
   * @param status - Terminal optimistic status (`"sent"` / `"failed"`).
   */
  resolvePending(ids: Iterable<string>, status: OptimisticStatus): void {
    let next: Map<string, MessageMetadata> | undefined;
    for (const id of ids) {
      if (!this.#pendingOptimisticIds.has(id)) continue;
      this.#pendingOptimisticIds.delete(id);
      next ??= new Map(this.store.getSnapshot());
      const prev = next.get(id);
      next.set(id, {
        parentCheckpointId: prev?.parentCheckpointId,
        ...prev,
        optimisticStatus: status,
      });
    }
    if (next != null) this.store.setState(() => next);
  }

  /**
   * Snapshot of ids whose optimistic status is `"pending"` or
   * `"failed"` — i.e. messages applied locally that the server has not
   * echoed. Used by {@link StreamController.hydrate} to drop
   * never-persisted optimistic messages so a reload converges to
   * server truth.
   */
  unpersistedOptimisticIds(): Set<string> {
    const ids = new Set<string>(this.#pendingOptimisticIds);
    for (const [id, meta] of this.store.getSnapshot()) {
      if (meta.optimisticStatus === "failed") ids.add(id);
    }
    return ids;
  }

  /**
   * Drop all metadata for the given ids. Called after never-persisted
   * optimistic messages are removed from the projection on
   * {@link StreamController.hydrate}, so their status doesn't linger.
   *
   * @param ids - Message ids to forget.
   */
  forget(ids: Iterable<string>): void {
    let changed = false;
    const next = new Map(this.store.getSnapshot());
    for (const id of ids) {
      this.#pendingOptimisticIds.delete(id);
      if (next.delete(id)) changed = true;
    }
    if (changed) this.store.setState(() => next);
  }
}

/** A `/history` entry, as far as {@link findForkPoints} reads it. */
export type HistoryEntry = Partial<
  Pick<ThreadState, "checkpoint" | "parent_checkpoint" | "tasks" | "values">
>;

/** One `/history` read: `before` and `checkpoint` are checkpoint ids. */
export type HistoryReader = (options: {
  limit: number;
  before?: string;
  checkpoint?: string;
  select: ThreadStateSelectField[];
}) => Promise<HistoryEntry[]>;

// The first pages are small: a read after a run needs only that run's steps,
// and most messages the steps miss are in the newest two checkpoints.
const STEP_PAGES = [10, 100, 100, 100, 100, 100];
const MESSAGES_PAGES = [2, 10, 10];

const checkpointOf = (entry: HistoryEntry | undefined) =>
  entry?.checkpoint?.checkpoint_id ?? undefined;

/**
 * Visits the thread's checkpoints from `start`, or else the newest, along
 * `parent_checkpoint`, which skips other branches' checkpoints, reading the
 * next page of older ones, sized by `pages`, whenever a checkpoint it needs
 * isn't read yet. Stops when `visit` returns `true` or at the chain's first
 * checkpoint, or else when the pages run out or one comes back empty, which
 * `limited` reports.
 */
async function walkChain(
  read: (limit: number, before?: string) => Promise<HistoryEntry[]>,
  pages: readonly number[],
  visit: (entry: HistoryEntry) => boolean,
  start?: string
): Promise<{ last?: HistoryEntry; limited: boolean }> {
  let page = await read(pages[0]);
  let loaded = 1;
  const byId = new Map(page.map((entry) => [checkpointOf(entry), entry]));
  const find = async (id: string) => {
    while (!byId.has(id) && loaded < pages.length) {
      page = await read(pages[loaded], checkpointOf(page.at(-1)));
      if (page.length === 0) break;
      loaded += 1;
      for (const older of page) byId.set(checkpointOf(older), older);
    }
    return byId.get(id);
  };

  let entry = start == null ? page.at(0) : await find(start);
  if (entry == null) return { limited: start != null };
  for (;;) {
    if (visit(entry)) return { last: entry, limited: false };
    const parentId = entry.parent_checkpoint?.checkpoint_id;
    if (parentId == null) return { last: entry, limited: false };
    const parent = await find(parentId);
    if (parent == null) return { last: entry, limited: true };
    entry = parent;
  }
}

function messageIds(value: unknown): string[] {
  const messages = Array.isArray(value) ? value : [value];
  return messages.flatMap((message) => {
    const { id, type } = (message ?? {}) as { id?: unknown; type?: unknown };
    return typeof id === "string" && type !== "remove" ? [id] : [];
  });
}

/**
 * Where each of `targets` can be forked from: the checkpoint right before the
 * message first appeared, read back from `head`, the checkpoint whose messages
 * are shown, or else the thread's newest checkpoint.
 *
 * It reads what each step wrote (`tasks`), which holds each message once,
 * and takes a message's oldest write, since a graph that runs a subgraph as
 * a node writes every earlier message again each turn. It stops at a
 * checkpoint in `seen`, which an earlier call read, at the chain's first
 * checkpoint or after about 500 steps, and after the first page from a
 * server that ignores `select` and sends whole states. Messages no step in
 * that range wrote with their id, such as ones added with `updateState` or
 * by a run that keeps no step writes (`durability: "exit"`), are placed from
 * the messages of the newest checkpoints instead, as the parent of the oldest
 * one that still holds them. Messages older than the range, or not saved,
 * get none.
 *
 * Returns the fork points found and the checkpoints whose steps it read.
 */
export async function findForkPoints(
  read: HistoryReader,
  messagesKey: string,
  targets: ReadonlySet<string>,
  { seen = new Set(), head }: { seen?: ReadonlySet<string>; head?: string } = {}
): Promise<{ forkPoints: Map<string, string>; visited: string[] }> {
  const valuesKey: ThreadStateSelectField = `values.${messagesKey}`;
  const held = (entry: HistoryEntry | undefined) =>
    new Set(
      messageIds((entry?.values as Record<string, unknown>)?.[messagesKey])
    );

  const forkPoints = new Map<string, string>();
  const visited: string[] = [];
  let wholeStates = false;
  const steps = await walkChain(
    async (limit, before) => {
      if (wholeStates) return [];
      const page = await read({
        limit,
        before,
        select: ["checkpoint", "parent_checkpoint", "tasks"],
      });
      wholeStates = page.some((entry) => entry.values !== undefined);
      return page;
    },
    STEP_PAGES,
    (entry) => {
      const id = checkpointOf(entry);
      if (id == null) return false;
      visited.push(id);
      for (const task of entry.tasks ?? []) {
        const writes = (task.result ?? {}) as Record<string, unknown>;
        for (const messageId of messageIds(writes[messagesKey])) {
          if (targets.has(messageId)) forkPoints.set(messageId, id);
        }
      }
      return seen.has(id);
    },
    head
  );

  // Stopped short, the messages the oldest checkpoint read already holds
  // were first written further back.
  let older = new Set<string>();
  const bottom = checkpointOf(steps.last);
  if (steps.limited && bottom != null) {
    const [entry] = await read({
      limit: 1,
      checkpoint: bottom,
      select: ["checkpoint", valuesKey],
    });
    older = held(entry);
    for (const messageId of older) forkPoints.delete(messageId);
  }

  const missing = new Set(
    [...targets].filter(
      (messageId) => !forkPoints.has(messageId) && !older.has(messageId)
    )
  );
  if (missing.size === 0) return { forkPoints, visited };
  let first = true;
  await walkChain(
    (limit, before) =>
      read({
        limit,
        before,
        select: ["checkpoint", "parent_checkpoint", valuesKey],
      }),
    MESSAGES_PAGES,
    (entry) => {
      const here = held(entry);
      const id = checkpointOf(entry);
      for (const messageId of missing) {
        if (here.has(messageId)) continue;
        // The newest checkpoint without the message is the one before it
        // appeared, unless that is the head: then it isn't saved.
        if (!first && id != null) forkPoints.set(messageId, id);
        missing.delete(messageId);
      }
      first = false;
      return missing.size === 0;
    },
    head
  );
  return { forkPoints, visited };
}
