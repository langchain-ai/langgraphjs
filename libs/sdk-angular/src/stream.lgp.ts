import { signal, computed, effect } from "@angular/core";
import {
  StreamOrchestrator,
  ensureMessageInstances,
  type MessageMetadata,
  type AnyStreamOptions,
  type SubmitOptions,
  type GetConfigurableType,
  type GetInterruptType,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type Message,
  type Interrupt,
  type BagTemplate,
} from "@langchain/langgraph-sdk";
import { createReactiveSubagentAccessors } from "./subagents.js";

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>) {
  type ConfigurableType = GetConfigurableType<Bag>;
  type InterruptType = GetInterruptType<Bag>;

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const orchestrator = new StreamOrchestrator<StateType, Bag>(options, {
    getClient: () => client,
    getAssistantId: () => options.assistantId,
    getMessagesKey: () => options.messagesKey ?? "messages",
  });

  orchestrator.initThreadId(options.threadId ?? undefined);

  const version = signal(0);
  const subagentVersion = signal(0);
  const reactiveSubagents = createReactiveSubagentAccessors(
    {
      getSubagent: (toolCallId) => orchestrator.getSubagent(toolCallId),
      getSubagentsByType: (type) => orchestrator.getSubagentsByType(type),
      getSubagentsByMessage: (messageId) =>
        orchestrator.getSubagentsByMessage(messageId),
    },
    subagentVersion
  );

  effect((onCleanup) => {
    const unsubscribe = orchestrator.subscribe(() => {
      version.update((v) => v + 1);
      subagentVersion.update((v) => v + 1);
    });
    onCleanup(() => unsubscribe());
  });

  // Subagent reconstruction
  effect((onCleanup) => {
    void version();
    const hvMessages = orchestrator.messages;
    const should =
      options.filterSubagentMessages &&
      !orchestrator.isLoading &&
      !orchestrator.historyData.isLoading &&
      hvMessages.length > 0;
    if (should) {
      const controller = orchestrator.reconstructSubagentsIfNeeded();
      if (controller) {
        onCleanup(() => controller.abort());
      }
    }
  });

  // Queue draining - track isLoading changes specifically so the drain
  // fires exactly when stream transitions from loading → idle
  const isLoadingForDrain = computed(() => {
    void version();
    return orchestrator.isLoading;
  });
  effect(() => {
    void isLoadingForDrain();
    orchestrator.drainQueue();
  });

  // Auto-reconnect
  const { shouldReconnect } = orchestrator;
  let hasReconnected = false;

  effect(() => {
    void version();
    const tid = orchestrator.threadId;
    if (!hasReconnected && shouldReconnect && tid && !orchestrator.isLoading) {
      const reconnected = orchestrator.tryReconnect();
      if (reconnected) hasReconnected = true;
    }
  });

  const values = computed(() => {
    void version();
    orchestrator.trackStreamMode("values");
    return orchestrator.values;
  });

  const error = computed(() => {
    void version();
    return orchestrator.error;
  });

  const isLoading = signal(orchestrator.isLoading);
  effect(() => {
    void version();
    isLoading.set(orchestrator.isLoading);
  });

  const branch = signal<string>("");
  effect(() => {
    void version();
    const b = orchestrator.branch;
    if (branch() !== b) branch.set(b);
  });

  const messages = computed(() => {
    void version();
    orchestrator.trackStreamMode("messages-tuple", "values");
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCalls = computed(() => {
    void version();
    orchestrator.trackStreamMode("messages-tuple", "values");
    return orchestrator.toolCalls;
  });

  const interrupt = computed(() => {
    void version();
    return orchestrator.interrupt;
  });

  const interrupts = computed((): Interrupt<InterruptType>[] => {
    void version();
    return orchestrator.interrupts as Interrupt<InterruptType>[];
  });

  const historyList = computed(() => {
    void version();
    return orchestrator.flatHistory;
  });

  const isThreadLoading = computed(() => {
    void version();
    return orchestrator.isThreadLoading;
  });

  const experimentalBranchTree = computed(() => {
    void version();
    return orchestrator.experimental_branchTree;
  });

  const queueEntries = signal(orchestrator.queueEntries);
  const queueSize = signal(orchestrator.queueSize);
  effect(() => {
    void version();
    queueEntries.set(orchestrator.queueEntries);
    queueSize.set(orchestrator.queueSize);
  });

  const subagents = computed(() => {
    void subagentVersion();
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return reactiveSubagents.mapSubagents(
      orchestrator.subagents as ReadonlyMap<
        string,
        typeof orchestrator.subagents extends Map<string, infer V> ? V : never
      >
    );
  });

  const activeSubagents = computed(() => {
    void subagentVersion();
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return reactiveSubagents.mapActiveSubagents(
      orchestrator.activeSubagents as readonly (typeof orchestrator.activeSubagents extends (infer V)[]
        ? V
        : never)[]
    );
  });

  return {
    assistantId: options.assistantId,
    client,

    values,
    error,
    isLoading,

    branch,
    setBranch(value: string) {
      orchestrator.setBranch(value);
    },

    messages,
    toolCalls,
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    interrupt,
    interrupts,

    history: historyList,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata(
      message: Message,
      index?: number
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: (
      values: StateType,
      submitOptions?: SubmitOptions<StateType, ConfigurableType>
    ) => orchestrator.submit(values, submitOptions),
    stop: () => orchestrator.stop(),
    joinStream: (...args: Parameters<typeof orchestrator.joinStream>) =>
      orchestrator.joinStream(...args),

    queue: {
      entries: queueEntries,
      size: queueSize,
      cancel: (id: string) => orchestrator.cancelQueueItem(id),
      clear: () => orchestrator.clearQueue(),
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    subagents,
    activeSubagents,
    getSubagent(toolCallId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return orchestrator.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return orchestrator.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return orchestrator.getSubagentsByMessage(messageId);
    },
  };
}
