import { onDestroy } from "svelte";
import {
  CustomStreamOrchestrator,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
  type GetUpdateType,
  type GetInterruptType,
  type GetConfigurableType,
  type MessageMetadata,
} from "@langchain/langgraph-sdk/ui";
import type { BagTemplate, Message, Interrupt } from "@langchain/langgraph-sdk";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamCustomOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  const orchestrator = new CustomStreamOrchestrator<StateType, Bag>(options);

  let version = $state(0);
  let branchValue = $state("");

  const unsubscribe = orchestrator.subscribe(() => {
    version++;
  });

  onDestroy(() => {
    unsubscribe();
    orchestrator.dispose();
  });

  const values = $derived.by(() => {
    void version;
    return orchestrator.values;
  });

  const messagesValue = $derived.by(() => {
    void version;
    return orchestrator.messages;
  });

  const toolCallsValue = $derived.by(() => {
    void version;
    return orchestrator.toolCalls;
  });

  const interruptValue = $derived.by(() => {
    void version;
    return orchestrator.interrupt as Interrupt<InterruptType> | undefined;
  });

  const interruptsValue = $derived.by(() => {
    void version;
    return orchestrator.interrupts as Interrupt<InterruptType>[];
  });

  const subagentsValue = $derived.by(() => {
    void version;
    return orchestrator.subagents;
  });

  const activeSubagentsValue = $derived.by(() => {
    void version;
    return orchestrator.activeSubagents;
  });

  const errorValue = $derived.by(() => {
    void version;
    return orchestrator.error;
  });

  const isLoadingValue = $derived.by(() => {
    void version;
    return orchestrator.isLoading;
  });

  return {
    get values() {
      return values;
    },
    get error() {
      return errorValue;
    },
    get isLoading() {
      return isLoadingValue;
    },

    stop: () => orchestrator.stop(),

    async submit(
      submitValues: UpdateType | null | undefined,
      submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
    ) {
      await orchestrator.submit(submitValues, submitOptions);
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    get branch() {
      return branchValue;
    },
    setBranch(value: string) {
      branchValue = value;
      orchestrator.setBranch(value);
    },

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    queue: {
      get entries() {
        return [] as never[];
      },
      get size() {
        return 0;
      },
      async cancel() {
        return false;
      },
      async clear() {},
    },

    get interrupt() {
      return interruptValue;
    },
    get interrupts() {
      return interruptsValue;
    },

    get messages() {
      return messagesValue;
    },
    get toolCalls() {
      return toolCallsValue;
    },
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get subagents() {
      return subagentsValue;
    },
    get activeSubagents() {
      return activeSubagentsValue;
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
