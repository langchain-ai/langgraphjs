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
import {
  isBrowserToolInterrupt,
  handleBrowserToolInterrupt,
} from "@langchain/langgraph-sdk";
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
    options as unknown as AnyStreamCustomOptions<StateType, Bag>
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
    { flush: "sync" }
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
    { immediate: true }
  );

  // Cached computed properties — unlike plain getters, `computed()` only
  // recomputes when a tracked dependency changes, and caches the result
  // between reads. Getters below unwrap `.value` so callers see plain
  // values (matching the original API surface).
  //
  // `void isLoading.value` / reading `streamValues.value` accesses the
  // ref solely to register it as a dependency of the computed, so Vue
  // knows to invalidate the cached value when the orchestrator pushes an
  // update. The `void` operator discards the unused value and signals
  // intent to future readers.
  const interruptsComputed = computed(() => {
    void isLoading.value;
    return orchestrator.interrupts as Interrupt<InterruptType>[];
  });

  const interruptComputed = computed(() => {
    void isLoading.value;
    return orchestrator.interrupt as Interrupt<InterruptType> | undefined;
  });

  const messagesComputed = computed(() => {
    if (!streamValues.value) return [];
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCallsComputed = computed(() => {
    if (!streamValues.value) return [];
    return orchestrator.toolCalls;
  });

  const queueEntries = shallowRef<unknown[]>([]);
  const queueSize = shallowRef(0);

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
  ) => {
    await orchestrator.submit(values, submitOptions);
  };

  const handledBrowserTools = new Set<string>();

  watch(
    () => toValue(options.threadId),
    () => {
      handledBrowserTools.clear();
    }
  );

  watch(streamValues, (vals) => {
    const { browserTools, onBrowserTool } = options;
    if (!browserTools?.length) return;

    const interrupts = vals?.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return;

    for (const interrupt of interrupts) {
      if (!isBrowserToolInterrupt(interrupt.value)) continue;

      const interruptId = interrupt.id ?? interrupt.value.toolCall.id ?? "";
      if (handledBrowserTools.has(interruptId)) continue;
      handledBrowserTools.add(interruptId);

      void handleBrowserToolInterrupt(
        interrupt.value,
        browserTools,
        onBrowserTool
      ).then((result) => {
        void submit(null, {
          command: {
            resume: result.toolCallId
              ? { [result.toolCallId]: result.value }
              : result.value,
          },
        });
      });
    }
  });

  return {
    get values() {
      return streamValues.value ?? ({} as StateType);
    },

    error: streamError,
    isLoading,

    stop: () => orchestrator.stop(),

    submit,

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
      index?: number
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    queue: reactive({
      entries: queueEntries,
      size: queueSize,
      cancel: async () => false,
      clear: async () => {},
    }),

    get interrupts(): Interrupt<InterruptType>[] {
      return interruptsComputed.value;
    },
    get interrupt(): Interrupt<InterruptType> | undefined {
      return interruptComputed.value;
    },
    get messages() {
      return messagesComputed.value;
    },
    get toolCalls() {
      return toolCallsComputed.value;
    },

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
      void subagentsRef.value;
      return orchestrator.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      void subagentsRef.value;
      return orchestrator.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      void subagentsRef.value;
      return orchestrator.getSubagentsByMessage(messageId);
    },
  };
}
