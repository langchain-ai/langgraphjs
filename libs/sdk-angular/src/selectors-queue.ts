import {
  DestroyRef,
  computed,
  inject,
  signal,
  type Signal,
} from "@angular/core";
import type {
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "@langchain/langgraph-sdk/stream";
import {
  STREAM_CONTROLLER,
  type AnyStream,
  type UseStreamReturn,
} from "./use-stream.js";

/**
 * Reactive handle on the server-side submission queue.
 *
 * Populated when `submit()` is invoked with
 * `multitaskStrategy: "enqueue"` while another run is in flight. The
 * returned `entries` signal is stable per snapshot so consumers can
 * feed it straight into Angular `@for` loops:
 *
 * ```html
 * @for (entry of queue.entries(); track entry.id) {
 *   <div>{{ entry.values | json }}</div>
 * }
 * ```
 *
 * Today the queue is maintained client-side; once the server starts
 * emitting a dedicated queue channel (roadmap A0.3) the controller
 * will mirror that state directly — the selector surface will not
 * change.
 */
export interface InjectSubmissionQueueReturn<
  StateType extends object = Record<string, unknown>,
> {
  readonly entries: Signal<SubmissionQueueSnapshot<StateType>>;
  readonly size: Signal<number>;
  cancel(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

type StreamHandle<StateType extends object> = UseStreamReturn<
  StateType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

export function injectSubmissionQueue<StateType extends object>(
  stream: StreamHandle<StateType>
): InjectSubmissionQueueReturn<StateType>;
export function injectSubmissionQueue(
  stream: AnyStream
): InjectSubmissionQueueReturn;
export function injectSubmissionQueue(
  stream: AnyStream
): InjectSubmissionQueueReturn {
  const destroyRef = inject(DestroyRef);
  const controller = stream[STREAM_CONTROLLER];
  const store = controller.queueStore;

  const entriesSignal = signal<SubmissionQueueSnapshot>(store.getSnapshot());
  const unsubscribe = store.subscribe(() =>
    entriesSignal.set(store.getSnapshot())
  );
  destroyRef.onDestroy(unsubscribe);

  const entries = computed(() => entriesSignal());
  const size = computed(() => entriesSignal().length);

  return {
    entries,
    size,
    cancel: (id) => controller.cancelQueued(id),
    clear: () => controller.clearQueue(),
  };
}

export type { SubmissionQueueEntry, SubmissionQueueSnapshot };
