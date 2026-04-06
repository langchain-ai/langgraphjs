import { writable, derived, fromStore } from "svelte/store";
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
import { createReactiveSubagentAccessors } from "./subagents.js";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamCustomOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  const orchestrator = new CustomStreamOrchestrator<StateType, Bag>(options);

  const version = writable(0);
  const branch = writable<string>("");
  const reactiveSubagents = createReactiveSubagentAccessors(
    {
      getSubagent: (toolCallId) => orchestrator.getSubagent(toolCallId),
      getSubagentsByType: (type) => orchestrator.getSubagentsByType(type),
      getSubagentsByMessage: (messageId) =>
        orchestrator.getSubagentsByMessage(messageId),
    },
    version
  );

  const unsubscribe = orchestrator.subscribe(() => {
    version.update((v) => v + 1);
  });

  onDestroy(() => {
    unsubscribe();
    orchestrator.dispose();
  });

  const valuesStore = derived(version, () => orchestrator.values);

  const messagesStore = derived(version, () => orchestrator.messages);

  const toolCallsStore = derived(version, () => orchestrator.toolCalls);

  const interruptStore = derived(
    version,
    () => orchestrator.interrupt as Interrupt<InterruptType> | undefined
  );

  const interruptsStore = derived(
    version,
    () => orchestrator.interrupts as Interrupt<InterruptType>[]
  );

  const subagentsStore = derived(version, () =>
    reactiveSubagents.mapSubagents(orchestrator.subagents)
  );
  const activeSubagentsStore = derived(version, () =>
    reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents)
  );

  const emptyEntries = writable<never[]>([]);
  const emptySize = writable(0);

  const valuesRef = fromStore(valuesStore);
  const errorRef = fromStore(derived(version, () => orchestrator.error));
  const isLoadingRef = fromStore(
    derived(version, () => orchestrator.isLoading)
  );
  const branchRef = fromStore(branch);
  const messagesRef = fromStore(messagesStore);
  const toolCallsRef = fromStore(toolCallsStore);
  const interruptRef = fromStore(interruptStore);
  const interruptsRef = fromStore(interruptsStore);
  const subagentsRef = fromStore(subagentsStore);
  const activeSubagentsRef = fromStore(activeSubagentsStore);
  const emptyEntriesRef = fromStore(emptyEntries);
  const emptySizeRef = fromStore(emptySize);

  return {
    get values() {
      return valuesRef.current;
    },
    get error() {
      return errorRef.current;
    },
    get isLoading() {
      return isLoadingRef.current;
    },

    stop: () => orchestrator.stop(),

    async submit(
      values: UpdateType | null | undefined,
      submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
    ) {
      await orchestrator.submit(values, submitOptions);
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    get branch() {
      return branchRef.current;
    },
    setBranch(value: string) {
      branch.set(value);
      orchestrator.setBranch(value);
    },

    getMessagesMetadata(
      message: Message,
      index?: number
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    queue: {
      get entries() {
        return emptyEntriesRef.current;
      },
      get size() {
        return emptySizeRef.current;
      },
      async cancel() {
        return false;
      },
      async clear() {},
    },

    get interrupt() {
      return interruptRef.current;
    },
    get interrupts() {
      return interruptsRef.current;
    },

    get messages() {
      return messagesRef.current;
    },
    get toolCalls() {
      return toolCallsRef.current;
    },
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get subagents() {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return subagentsRef.current;
    },
    get activeSubagents() {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return activeSubagentsRef.current;
    },
    getSubagent(toolCallId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagentsByMessage(messageId);
    },
  };
}
