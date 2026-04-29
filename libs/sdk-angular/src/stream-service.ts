import {
  DestroyRef,
  EnvironmentInjector,
  Injectable,
  inject,
  runInInjectionContext,
  type Signal,
} from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import type {
  AssembledToolCall,
  InferStateType,
  StreamSubmitOptions,
  SubgraphDiscoverySnapshot,
  WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";
import type { ThreadStream } from "@langchain/langgraph-sdk/client";
import {
  useStream,
  STREAM_CONTROLLER,
  type StreamApi,
  type UseStreamOptions,
  type UseStreamReturn,
} from "./use-stream.js";

/**
 * `@Injectable()` wrapper around {@link useStream}. Extend this class
 * with your own service when you want a DI-scoped, shareable
 * {@link StreamApi}:
 *
 * ```ts
 * @Injectable({ providedIn: "root" })
 * export class ChatStream extends StreamService<ChatState> {
 *   constructor() {
 *     super({
 *       transport: new HttpAgentServerAdapter({ apiUrl: "/api/graph" }),
 *       assistantId: "chat",
 *     });
 *   }
 * }
 * ```
 *
 * The service exposes the same `StreamApi` surface as
 * `injectStream()` — read data via signals (`service.messages()`,
 * `service.isLoading()`) and use the imperative methods
 * (`service.submit(...)`, `service.stop()`).
 *
 * Must be instantiated inside an Angular injection context. Its
 * {@link DestroyRef} owns the controller lifetime, so scoping the
 * service to a component tears down the stream when the component
 * is destroyed.
 */
@Injectable()
export class StreamService<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> {
  /** Underlying `StreamApi` returned by {@link useStream}. */
  readonly stream: UseStreamReturn<T, InterruptType, ConfigurableType>;

  constructor(options: UseStreamOptions<InferStateType<T>>) {
    const injector = inject(EnvironmentInjector);
    const destroyRef = inject(DestroyRef);
    this.stream = runInInjectionContext(injector, () =>
      useStream<T, InterruptType, ConfigurableType>(options, destroyRef)
    );
  }

  // ─── Reactive accessors (pass-through) ────────────────────────────

  get values(): UseStreamReturn<T, InterruptType, ConfigurableType>["values"] {
    return this.stream.values;
  }

  get messages(): Signal<BaseMessage[]> {
    return this.stream.messages;
  }

  get toolCalls(): Signal<AssembledToolCall[]> {
    return this.stream.toolCalls;
  }

  get interrupts(): Signal<Interrupt<InterruptType>[]> {
    return this.stream.interrupts;
  }

  get interrupt(): Signal<Interrupt<InterruptType> | undefined> {
    return this.stream.interrupt;
  }

  get isLoading(): Signal<boolean> {
    return this.stream.isLoading;
  }

  get isThreadLoading(): Signal<boolean> {
    return this.stream.isThreadLoading;
  }

  get error(): Signal<unknown> {
    return this.stream.error;
  }

  get threadId(): Signal<string | null> {
    return this.stream.threadId;
  }

  get hydrationPromise(): Signal<Promise<void>> {
    return this.stream.hydrationPromise;
  }

  get subagents(): UseStreamReturn<
    T,
    InterruptType,
    ConfigurableType
  >["subagents"] {
    return this.stream.subagents;
  }

  get subgraphs(): Signal<ReadonlyMap<string, SubgraphDiscoverySnapshot>> {
    return this.stream.subgraphs;
  }

  get subgraphsByNode(): Signal<
    ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>
  > {
    return this.stream.subgraphsByNode;
  }

  // ─── Identity ─────────────────────────────────────────────────────

  get client(): Client {
    return this.stream.client;
  }

  get assistantId(): string {
    return this.stream.assistantId;
  }

  // ─── Imperatives ──────────────────────────────────────────────────

  submit(
    input: WidenUpdateMessages<Partial<InferStateType<T>>> | null | undefined,
    options?: StreamSubmitOptions<InferStateType<T>, ConfigurableType>
  ): Promise<void> {
    return this.stream.submit(
      input as Parameters<this["stream"]["submit"]>[0],
      options as Parameters<this["stream"]["submit"]>[1]
    );
  }

  stop(): Promise<void> {
    return this.stream.stop();
  }

  respond(
    response: unknown,
    target?: { interruptId: string; namespace?: string[] }
  ): Promise<void> {
    return this.stream.respond(response, target);
  }

  getThread(): ThreadStream | undefined {
    return this.stream.getThread();
  }

  /** @internal Lets selector primitives resolve the controller. */
  get [STREAM_CONTROLLER](): StreamApi<
    T,
    InterruptType,
    ConfigurableType
  >[typeof STREAM_CONTROLLER] {
    return this.stream[STREAM_CONTROLLER];
  }
}
