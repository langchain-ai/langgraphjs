/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  GetConfigurableType,
  GetCustomEventType,
  GetInterruptType,
  GetToolCallsType,
  GetUpdateType,
  RunCallbackMeta,
  UseStreamCustomOptions,
  CustomSubmitOptions,
} from "../ui/types.js";
import type { UseStreamCustom } from "./types.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import { MessageTupleManager } from "../ui/messages.js";
import { Interrupt } from "../schema.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import { useControllableThreadId } from "./thread.js";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: UseStreamCustomOptions<StateType, Bag>
): UseStreamCustom<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type ToolCallType = GetToolCallsType<StateType>;

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
  });

  // Bridge StreamManager's external store into Vue reactivity.
  const snapshot = shallowRef(stream.getSnapshot());
  const unsubscribe = stream.subscribe(() => {
    snapshot.value = stream.getSnapshot();
  });

  const historyValues = (options.initialValues ??
    ({} as StateType)) as StateType;

  onScopeDispose(() => {
    unsubscribe();
    // Stop any in-flight stream when the owning scope is disposed.
    void stream.stop(historyValues, { onStop: options.onStop });
  });

  const [threadId, onThreadId] = useControllableThreadId(options);
  const threadIdRef = shallowRef<string | null>(threadId.value);

  // Cancel the stream if thread ID has changed
  watch(
    threadId,
    (next) => {
      if (threadIdRef.value !== next) {
        threadIdRef.value = next;
        stream.clear();
      }
    },
    { flush: "sync" }
  );

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey])
      ? (value[messagesKey] as Message[])
      : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const stop = () => stream.stop(historyValues, { onStop: options.onStop });

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
  ) => {
    let callbackMeta: RunCallbackMeta | undefined;
    let usableThreadId = threadId.value;

    stream.setStreamValues(() => {
      if (submitOptions?.optimisticValues != null) {
        return {
          ...historyValues,
          ...(typeof submitOptions.optimisticValues === "function"
            ? submitOptions.optimisticValues(historyValues)
            : submitOptions.optimisticValues),
        };
      }
      return { ...historyValues };
    });

    await stream.start(
      async (signal: AbortSignal) => {
        if (!usableThreadId) {
          // generate random thread id
          usableThreadId = crypto.randomUUID();
          threadIdRef.value = usableThreadId;
          onThreadId(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return options.transport.stream({
          input: values,
          context: submitOptions?.context,
          command: submitOptions?.command,
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
        getMessages,
        setMessages,
        initialValues: {} as StateType,
        callbacks: options,
        onSuccess: () => undefined,
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
      }
    );
  };

  const streamValues = computed(() => snapshot.value.values?.[0] ?? null);
  const valuesRef = computed(() => streamValues.value ?? ({} as StateType));

  const interrupt = computed((): Interrupt<InterruptType> | undefined => {
    const v = streamValues.value;
    if (
      v != null &&
      "__interrupt__" in v &&
      Array.isArray((v as any).__interrupt__) // eslint-disable-line @typescript-eslint/no-explicit-any
    ) {
      const valueInterrupts = (v as any).__interrupt__ as unknown[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (valueInterrupts.length === 0) return { when: "breakpoint" };
      if (valueInterrupts.length === 1) return valueInterrupts[0] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      // TODO: fix the typing of interrupts if multiple interrupts are returned
      return valueInterrupts as unknown as Interrupt<InterruptType>;
    }
    return undefined;
  });

  const messages = computed((): Message<ToolCallType>[] => {
    const v = streamValues.value;
    if (!v) return [];
    return getMessages(v) as Message<ToolCallType>[];
  });

  const toolCalls = computed(() => {
    const msgs = messages.value;
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  return {
    values: valuesRef,
    error: computed(() => snapshot.value.error),
    isLoading: computed(() => snapshot.value.isLoading),
    stop,
    submit,
    interrupt,
    messages,
    toolCalls,
    getToolCalls(message) {
      const allToolCalls = toolCalls.value;
      return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
    },
  };
}
