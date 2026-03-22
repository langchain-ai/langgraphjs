import { onMount, onDestroy } from "svelte";

import {
  StreamOrchestrator,
  ensureMessageInstances,
  type MessageMetadata,
  type AnyStreamOptions,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type BagTemplate,
  type Message,
} from "@langchain/langgraph-sdk";

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>) {
  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const orchestrator = new StreamOrchestrator<StateType, Bag>(options, {
    getClient: () => client,
    getAssistantId: () => options.assistantId,
    getMessagesKey: () => options.messagesKey ?? "messages",
  });

  orchestrator.initThreadId(options.threadId ?? undefined);

  let version = $state(0);
  const unsubscribe = orchestrator.subscribe(() => {
    version++;
  });

  let fetchController: AbortController | null = null;

  // Subagent reconstruction: only trigger when conditions change
  const shouldReconstruct = $derived.by(() => {
    void version;
    const hvMessages = orchestrator.messages;
    if (!options.filterSubagentMessages) return false;
    if (orchestrator.isLoading || orchestrator.historyData.isLoading)
      return false;
    return hvMessages.length > 0;
  });

  $effect(() => {
    if (shouldReconstruct) {
      fetchController?.abort();
      const controller = orchestrator.reconstructSubagentsIfNeeded();
      fetchController = controller;
    }
  });

  // Queue draining: fires when isLoading transitions
  const isLoadingForDrain = $derived.by(() => {
    void version;
    return orchestrator.isLoading;
  });

  $effect(() => {
    void isLoadingForDrain;
    orchestrator.drainQueue();
  });

  // Auto-reconnect
  let { shouldReconnect } = orchestrator;

  onMount(() => {
    if (shouldReconnect) {
      const reconnected = orchestrator.tryReconnect();
      if (reconnected) shouldReconnect = false;
    }
  });

  onDestroy(() => {
    fetchController?.abort();
    unsubscribe();
    orchestrator.dispose();
  });

  // Reactive derived values via Svelte 5 runes
  const values = $derived.by(() => {
    void version;
    orchestrator.trackStreamMode("values");
    return orchestrator.values;
  });

  const error = $derived.by(() => {
    void version;
    return orchestrator.error;
  });

  const isLoading = $derived.by(() => {
    void version;
    return orchestrator.isLoading;
  });

  const branch = $derived.by(() => {
    void version;
    return orchestrator.branch;
  });

  const messages = $derived.by(() => {
    void version;
    orchestrator.trackStreamMode("messages-tuple", "values");
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCalls = $derived.by(() => {
    void version;
    orchestrator.trackStreamMode("messages-tuple", "values");
    return orchestrator.toolCalls;
  });

  const interrupt = $derived.by(() => {
    void version;
    return orchestrator.interrupt;
  });

  const interrupts = $derived.by(() => {
    void version;
    return orchestrator.interrupts;
  });

  const historyList = $derived.by(() => {
    void version;
    return orchestrator.flatHistory;
  });

  const isThreadLoading = $derived.by(() => {
    void version;
    return orchestrator.isThreadLoading;
  });

  const experimentalBranchTree = $derived.by(() => {
    void version;
    return orchestrator.experimental_branchTree;
  });

  const subagents = $derived.by(() => {
    void version;
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return orchestrator.subagents;
  });

  const activeSubagents = $derived.by(() => {
    void version;
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return orchestrator.activeSubagents;
  });

  const queueEntries = $derived.by(() => {
    void version;
    return orchestrator.queueEntries;
  });

  const queueSize = $derived.by(() => {
    void version;
    return orchestrator.queueSize;
  });

  return {
    assistantId: options.assistantId,
    client,

    get values() {
      return values;
    },
    get error() {
      return error;
    },
    get isLoading() {
      return isLoading;
    },
    get isThreadLoading() {
      return isThreadLoading;
    },

    get branch() {
      return branch;
    },
    setBranch(value: string) {
      orchestrator.setBranch(value);
    },

    get messages() {
      return messages;
    },
    get toolCalls() {
      return toolCalls;
    },
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get interrupt() {
      return interrupt;
    },
    get interrupts() {
      return interrupts;
    },

    get history() {
      return historyList;
    },
    get experimental_branchTree() {
      return experimentalBranchTree;
    },

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: (...args: Parameters<typeof orchestrator.submit>) =>
      orchestrator.submit(...args),
    stop: () => orchestrator.stop(),
    joinStream: (...args: Parameters<typeof orchestrator.joinStream>) =>
      orchestrator.joinStream(...args),

    queue: {
      get entries() {
        return queueEntries;
      },
      get size() {
        return queueSize;
      },
      cancel: (id: string) => orchestrator.cancelQueueItem(id),
      clear: () => orchestrator.clearQueue(),
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    get subagents() {
      return subagents;
    },
    get activeSubagents() {
      return activeSubagents;
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
