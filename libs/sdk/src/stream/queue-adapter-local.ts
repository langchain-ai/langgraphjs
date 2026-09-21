import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import {
  EMPTY_QUEUE,
  type QueueAdapter,
  type SubmissionQueueEntry,
  type SubmissionQueueSnapshot,
} from "./queue-adapter.js";
import { StreamStore } from "./store.js";
import type { StreamSubmitOptions } from "./types.js";

/**
 * Client-only defer. Fallback when the transport exposes no
 * {@link ServerQueueCapability} (see `LocalQueueCapability`).
 */
export class LocalQueueAdapter<
  StateType extends object = Record<string, unknown>,
> implements QueueAdapter<StateType> {
  readonly #store: StreamStore<SubmissionQueueSnapshot<StateType>>;
  readonly #onError: (error: unknown) => void;

  constructor(
    store: StreamStore<SubmissionQueueSnapshot<StateType>>,
    onError: (error: unknown) => void
  ) {
    this.#store = store;
    this.#onError = onError;
  }

  async hydrate(): Promise<void> {
    // No-op. Nothing to hydrate from. The queue only ever reflects
    // what this session enqueued in memory.
  }

  async enqueue(
    _threadId: string,
    values: Partial<StateType> | null | undefined,
    options: StreamSubmitOptions<StateType> | undefined
  ): Promise<void> {
    const entry: SubmissionQueueEntry<StateType> = {
      id: uuidv7(),
      values,
      options,
      createdAt: new Date(),
    };
    this.#store.setState((current) => [...current, entry]);
  }

  onIdle(
    dispatch: (
      values: unknown,
      options: StreamSubmitOptions<StateType> | undefined
    ) => Promise<void>
  ): void {
    const [head, ...rest] = this.#store.getSnapshot();
    if (!head) return;
    this.#store.setState(() => rest);
    // Strip the strategy so the drained submission doesn't recursively re-enqueue.
    dispatch(head.values, {
      ...head.options,
      multitaskStrategy: undefined,
    }).catch(this.#onError); // dispatch already routes failures to rootStore.error
  }

  async cancel(id: string): Promise<boolean> {
    const current = this.#store.getSnapshot();
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) return false;
    this.#store.setState(() => next);
    return true;
  }

  async clear(): Promise<void> {
    this.#store.setState(
      () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
  }

  detach(): void {
    // Nothing to release.
  }
}
