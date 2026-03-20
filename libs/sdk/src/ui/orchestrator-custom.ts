import type { BaseMessage } from "@langchain/core/messages";

import type { ThreadState, Interrupt } from "../schema.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import { StreamManager, type EventStreamEvent } from "./manager.js";
import {
  MessageTupleManager,
  toMessageClass,
  ensureMessageInstances,
} from "./messages.js";
import { extractInterrupts } from "./interrupts.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import type {
  AnyStreamCustomOptions,
  CustomSubmitOptions,
  MessageMetadata,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetConfigurableType,
  SubagentStreamInterface,
} from "./types.js";

/**
 * Create a custom transport thread state.
 * @param values - The values to use.
 * @param threadId - The ID of the thread to use.
 * @returns The custom transport thread state.
 */
function createCustomTransportThreadState<
  StateType extends Record<string, unknown>
>(values: StateType, threadId: string): ThreadState<StateType> {
  return {
    values,
    next: [],
    tasks: [],
    metadata: undefined,
    created_at: null,
    checkpoint: {
      thread_id: threadId,
      checkpoint_id: null,
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: null,
  };
}

/**
 * Framework-agnostic orchestrator for custom transport streams.
 *
 * Encapsulates all business logic shared across React, Vue, Svelte, and Angular
 * for custom transport (non-LGP) streaming.
 */
export class CustomStreamOrchestrator<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  readonly stream: StreamManager<StateType, Bag>;
  readonly messageManager: MessageTupleManager;

  #threadId: string | null;
  #branch: string = "";

  readonly #options: AnyStreamCustomOptions<StateType, Bag>;
  readonly #historyValues: StateType;

  #listeners = new Set<() => void>();
  #version = 0;
  #streamUnsub: (() => void) | null = null;
  #disposed = false;

  constructor(options: AnyStreamCustomOptions<StateType, Bag>) {
    this.#options = options;

    this.#threadId = options.threadId ?? null;

    this.messageManager = new MessageTupleManager();
    this.stream = new StreamManager<StateType, Bag>(this.messageManager, {
      throttle: options.throttle ?? false,
      subagentToolNames: options.subagentToolNames,
      filterSubagentMessages: options.filterSubagentMessages,
      toMessage: options.toMessage ?? toMessageClass,
    });

    this.#historyValues = options.initialValues ?? ({} as StateType);

    this.#streamUnsub = this.stream.subscribe(() => {
      this.#notify();
    });

    const historyMessages = this.#getMessages(this.#historyValues);
    if (
      options.filterSubagentMessages &&
      !this.stream.isLoading &&
      historyMessages.length > 0
    ) {
      this.stream.reconstructSubagents(historyMessages, {
        skipIfPopulated: true,
      });
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.#version;

  #notify(): void {
    if (this.#disposed) return;
    this.#version += 1;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Sync the external thread ID. Clears stream if it changed.
   */
  syncThreadId(newId: string | null): void {
    if (newId !== this.#threadId) {
      this.#threadId = newId;
      this.stream.clear();
      this.#notify();
    }
  }

  #getMessages = (value: StateType): Message[] => {
    const messagesKey = this.#options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey])
      ? (value[messagesKey] as Message[])
      : [];
  };

  #setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = this.#options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  get values(): StateType {
    return this.stream.values ?? ({} as StateType);
  }

  get streamValues(): StateType | null {
    return this.stream.values;
  }

  get error(): unknown {
    return this.stream.error;
  }

  get isLoading(): boolean {
    return this.stream.isLoading;
  }

  get branch(): string {
    return this.#branch;
  }

  setBranch = (value: string): void => {
    this.#branch = value;
    this.#notify();
  };

  get messages(): BaseMessage[] {
    if (!this.stream.values) return [];
    return ensureMessageInstances(
      this.#getMessages(this.stream.values)
    ) as BaseMessage[];
  }

  get toolCalls() {
    if (!this.stream.values) return [];
    return getToolCallsWithResults(this.#getMessages(this.stream.values));
  }

  getToolCalls = (message: Message) => {
    if (!this.stream.values) return [];
    const allToolCalls = getToolCallsWithResults(
      this.#getMessages(this.stream.values)
    );
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  };

  get interrupts(): Interrupt<GetInterruptType<Bag>>[] {
    if (
      this.stream.values != null &&
      "__interrupt__" in this.stream.values &&
      Array.isArray(this.stream.values.__interrupt__)
    ) {
      const valueInterrupts = this.stream.values.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }
    return [];
  }

  get interrupt(): Interrupt<GetInterruptType<Bag>> | undefined {
    return extractInterrupts<GetInterruptType<Bag>>(this.stream.values);
  }

  getMessagesMetadata = (
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined => {
    const streamMetadata = this.messageManager.get(message.id)?.metadata;
    if (streamMetadata != null) {
      return {
        messageId: message.id ?? String(index),
        firstSeenState: undefined,
        branch: undefined,
        branchOptions: undefined,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }
    return undefined;
  };

  get subagents(): Map<string, SubagentStreamInterface> {
    return this.stream.getSubagents();
  }

  get activeSubagents(): SubagentStreamInterface[] {
    return this.stream.getActiveSubagents();
  }

  getSubagent = (toolCallId: string) => {
    return this.stream.getSubagent(toolCallId);
  };

  getSubagentsByType = (type: string) => {
    return this.stream.getSubagentsByType(type);
  };

  getSubagentsByMessage = (messageId: string) => {
    return this.stream.getSubagentsByMessage(messageId);
  };

  /**
   * Reconstruct subagents if needed (e.g. on isLoading change).
   */
  reconstructSubagentsIfNeeded(): void {
    const hvMessages = this.#getMessages(this.#historyValues);
    if (
      this.#options.filterSubagentMessages &&
      !this.stream.isLoading &&
      hvMessages.length > 0
    ) {
      this.stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
    }
  }

  stop = (): void => {
    void this.stream.stop(this.#historyValues, {
      onStop: this.#options.onStop,
    });
  };

  switchThread = (newThreadId: string | null): void => {
    if (newThreadId !== this.#threadId) {
      this.#threadId = newThreadId;
      this.stream.clear();
      this.#notify();
    }
  };

  submitDirect = async (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<void> => {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    const currentThreadId = this.#options.threadId ?? null;
    if (currentThreadId !== this.#threadId) {
      this.#threadId = currentThreadId;
      this.stream.clear();
    }

    let usableThreadId = this.#threadId ?? submitOptions?.threadId;

    this.stream.setStreamValues(() => {
      if (submitOptions?.optimisticValues != null) {
        return {
          ...this.#historyValues,
          ...(typeof submitOptions.optimisticValues === "function"
            ? submitOptions.optimisticValues(this.#historyValues)
            : submitOptions.optimisticValues),
        };
      }

      return { ...this.#historyValues };
    });

    await this.stream.start(
      async (signal: AbortSignal) => {
        if (!usableThreadId) {
          usableThreadId = crypto.randomUUID();
          this.#threadId = usableThreadId;
          this.#options.onThreadId?.(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return this.#options.transport.stream({
          input: values,
          context: submitOptions?.context,
          command: submitOptions?.command,
          streamSubgraphs: submitOptions?.streamSubgraphs,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: {
              thread_id: usableThreadId,
              ...submitOptions?.config?.configurable,
            } as unknown as GetConfigurableType<Bag>,
          },
        }) as Promise<
          AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
        >;
      },
      {
        getMessages: this.#getMessages,
        setMessages: this.#setMessages,
        initialValues: {} as StateType,
        callbacks: this.#options,
        onSuccess: () => {
          if (!usableThreadId) return undefined;

          const finalValues = this.stream.values ?? this.#historyValues;
          this.#options.onFinish?.(
            createCustomTransportThreadState(finalValues, usableThreadId),
            undefined
          );

          return undefined;
        },
        onError: (error) => {
          this.#options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        },
      }
    );
  };

  submit = async (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<void> => {
    await this.submitDirect(values, submitOptions);
  };

  dispose = (): void => {
    this.#disposed = true;
    this.#streamUnsub?.();
    this.#streamUnsub = null;
    void this.stream.stop(this.#historyValues, {
      onStop: this.#options.onStop,
    });
  };
}
