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
import { createReactiveSubagentAccessors } from "./subagents.js";

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
  const version = shallowRef(0);
  const reactiveSubagents = createReactiveSubagentAccessors(
    {
      getSubagent: (toolCallId) => orchestrator.getSubagent(toolCallId),
      getSubagentsByType: (type) => orchestrator.getSubagentsByType(type),
      getSubagentsByMessage: (messageId) =>
        orchestrator.getSubagentsByMessage(messageId),
    },
    version
  );
  const subagentsRef = shallowRef(
    reactiveSubagents.mapSubagents(orchestrator.subagents)
  );
  const activeSubagentsRef = shallowRef(
    reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents)
  );

  const unsubscribe = orchestrator.subscribe(() => {
    version.value += 1;
    streamValues.value = orchestrator.streamValues;
    streamError.value = orchestrator.error;
    isLoading.value = orchestrator.isLoading;
    subagentsRef.value = reactiveSubagents.mapSubagents(orchestrator.subagents);
    activeSubagentsRef.value = reactiveSubagents.mapActiveSubagents(
      orchestrator.activeSubagents
    );
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

  return {
    get values() {
      return streamValues.value ?? ({} as StateType);
    },

    error: streamError,
    isLoading,

    stop: () => orchestrator.stop(),

    submit: async (
      values: UpdateType | null | undefined,
      submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
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
      void messagesComputed.value.length;
      void version.value;
      return reactiveSubagents.mapSubagents(orchestrator.subagents);
    },

    get activeSubagents() {
      void messagesComputed.value.length;
      void version.value;
      return reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents);
    },

    getSubagent(toolCallId: string) {
      void messagesComputed.value.length;
      void version.value;
      return reactiveSubagents.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      void messagesComputed.value.length;
      void version.value;
      return reactiveSubagents.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      void messagesComputed.value.length;
      void version.value;
      return reactiveSubagents.getSubagentsByMessage(messageId);
    },
  };
}
