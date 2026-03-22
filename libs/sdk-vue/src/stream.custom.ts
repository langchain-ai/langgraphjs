import {
  computed,
  onScopeDispose,
  reactive,
  ref,
  shallowRef,
  toValue,
  watch,
} from "vue";
import {
  CustomStreamOrchestrator,
  ensureMessageInstances,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
  type GetUpdateType,
  type GetInterruptType,
  type GetConfigurableType,
  type MessageMetadata,
} from "@langchain/langgraph-sdk/ui";
import type { BagTemplate, Message, Interrupt } from "@langchain/langgraph-sdk";
import type { VueReactiveOptions } from "./types.js";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: VueReactiveOptions<AnyStreamCustomOptions<StateType, Bag>>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const orchestrator = new CustomStreamOrchestrator<StateType, Bag>(
    options as unknown as AnyStreamCustomOptions<StateType, Bag>,
  );

  const branch = ref<string>("");

  let threadId: string | null = toValue(options.threadId) ?? null;

  watch(
    () => toValue(options.threadId),
    (newId) => {
      const resolved = newId ?? null;
      if (resolved !== threadId) {
        threadId = resolved;
        orchestrator.syncThreadId(resolved);
      }
    },
    { flush: "sync" },
  );

  const streamValues = shallowRef<StateType | null>(null);
  const streamError = shallowRef<unknown>(undefined);
  const isLoading = shallowRef(false);
  const subagentsRef = shallowRef(orchestrator.subagents);
  const activeSubagentsRef = shallowRef(orchestrator.activeSubagents);

  const unsubscribe = orchestrator.subscribe(() => {
    streamValues.value = orchestrator.streamValues;
    streamError.value = orchestrator.error;
    isLoading.value = orchestrator.isLoading;
    subagentsRef.value = orchestrator.subagents;
    activeSubagentsRef.value = orchestrator.activeSubagents;
  });

  onScopeDispose(() => {
    unsubscribe();
    orchestrator.dispose();
  });

  watch(
    () => ({
      should:
        options.filterSubagentMessages &&
        !isLoading.value &&
        streamValues.value != null &&
        orchestrator.messages.length > 0,
      len: orchestrator.messages.length,
    }),
    ({ should }) => {
      if (should) {
        orchestrator.reconstructSubagentsIfNeeded();
      }
    },
    { immediate: true },
  );

  // Cached computed properties — unlike plain getters, `computed()` only
  // recomputes when a tracked dependency changes, and caches the result
  // between reads.
  //
  // `void isLoading.value` / `void streamValues.value` accesses the ref
  // solely to register it as a dependency of the computed, so that Vue
  // knows to invalidate the cached value when the orchestrator pushes an
  // update. The `void` operator discards the unused value and signals
  // intent to future readers.
  const interrupts = computed(() => {
    void isLoading.value;
    return orchestrator.interrupts as Interrupt<InterruptType>[];
  });

  const interrupt = computed(() => {
    void isLoading.value;
    return orchestrator.interrupt as Interrupt<InterruptType> | undefined;
  });

  const messages = computed(() => {
    if (!streamValues.value) return [];
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCalls = computed(() => {
    if (!streamValues.value) return [];
    return orchestrator.toolCalls;
  });

  const queueEntries = shallowRef<unknown[]>([]);
  const queueSize = shallowRef(0);

  return {
    get values() {
      return streamValues.value ?? ({} as StateType);
    },

    error: streamError,
    isLoading,

    stop: () => orchestrator.stop(),

    submit: async (
      values: UpdateType | null | undefined,
      submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
    ) => {
      await orchestrator.submit(values, submitOptions);
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    branch,
    setBranch(value: string) {
      branch.value = value;
      orchestrator.setBranch(value);
    },

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    queue: reactive({
      entries: queueEntries,
      size: queueSize,
      cancel: async () => false,
      clear: async () => {},
    }),

    interrupts,
    interrupt,
    messages,
    toolCalls,

    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get subagents() {
      return subagentsRef.value;
    },

    get activeSubagents() {
      return activeSubagentsRef.value;
    },

    getSubagent(toolCallId: string) {
      return orchestrator.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      return orchestrator.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      return orchestrator.getSubagentsByMessage(messageId);
    },
  };
}
