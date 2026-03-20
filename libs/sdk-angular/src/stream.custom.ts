import { signal, computed, effect } from "@angular/core";
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
import type {
  BagTemplate,
  Message,
  Interrupt,
} from "@langchain/langgraph-sdk";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamCustomOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const orchestrator = new CustomStreamOrchestrator<StateType, Bag>(options);

  const version = signal(0);

  effect((onCleanup) => {
    const unsubscribe = orchestrator.subscribe(() => {
      version.update((v) => v + 1);
    });
    onCleanup(() => unsubscribe());
  });

  effect(() => {
    const loading = !orchestrator.isLoading;
    void version();
    if (
      options.filterSubagentMessages &&
      loading &&
      orchestrator.messages.length > 0
    ) {
      orchestrator.reconstructSubagentsIfNeeded();
    }
  });

  const values = computed(() => {
    void version();
    return orchestrator.values;
  });

  const branch = signal<string>("");

  return {
    values,
    error: signal<unknown>(undefined),
    isLoading: signal(false),

    stop: orchestrator.stop,

    async submit(
      values: UpdateType | null | undefined,
      submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
    ) {
      await orchestrator.submit(values, submitOptions);
    },

    switchThread: orchestrator.switchThread,

    branch,
    setBranch(value: string) {
      branch.set(value);
      orchestrator.setBranch(value);
    },

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    queue: {
      entries: signal([]),
      size: signal(0),
      async cancel() {
        return false;
      },
      async clear() {},
    },

    interrupts: computed((): Interrupt<InterruptType>[] => {
      void version();
      return orchestrator.interrupts as Interrupt<InterruptType>[];
    }),

    interrupt: computed((): Interrupt<InterruptType> | undefined => {
      void version();
      return orchestrator.interrupt as Interrupt<InterruptType> | undefined;
    }),

    messages: computed(() => {
      void version();
      return ensureMessageInstances(orchestrator.messages);
    }),

    toolCalls: computed(() => {
      void version();
      return orchestrator.toolCalls;
    }),

    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get subagents() {
      void version();
      return orchestrator.subagents;
    },

    get activeSubagents() {
      void version();
      return orchestrator.activeSubagents;
    },

    getSubagent: orchestrator.getSubagent,
    getSubagentsByType: orchestrator.getSubagentsByType,
    getSubagentsByMessage: orchestrator.getSubagentsByMessage,
  };
}
