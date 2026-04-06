import { signal, computed, effect } from "@angular/core";
import {
  CustomStreamOrchestrator,
  ensureMessageInstances,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
  type GetUpdateType,
  type GetInterruptType,
  type GetConfigurableType,
  type GetToolCallsType,
  type MessageMetadata,
} from "@langchain/langgraph-sdk/ui";
import type { BagTemplate, Message, Interrupt } from "@langchain/langgraph-sdk";
import { createReactiveSubagentAccessors } from "./subagents.js";

export function injectStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamCustomOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type ToolCallType = GetToolCallsType<StateType>;

  const orchestrator = new CustomStreamOrchestrator<StateType, Bag>(options);

  const version = signal(0);
  const subagentVersion = signal(0);
  const isLoading = signal(orchestrator.isLoading);
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
      isLoading.set(orchestrator.isLoading);
    });
    onCleanup(() => unsubscribe());
  });

  effect(() => {
    void version();
    const loading = orchestrator.isLoading;
    const hvMessages = orchestrator.messages;
    if (options.filterSubagentMessages && !loading && hvMessages.length > 0) {
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
    error: computed(() => {
      void version();
      return orchestrator.error;
    }),
    isLoading,

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

    branch,
    setBranch(value: string) {
      branch.set(value);
      orchestrator.setBranch(value);
    },

    getMessagesMetadata(
      message: Message<ToolCallType>,
      index?: number
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

    getToolCalls(message: Message<ToolCallType>) {
      return orchestrator.getToolCalls(message);
    },

    subagents: computed(() => {
      void subagentVersion();
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.mapSubagents(
        orchestrator.subagents
      ) as ReadonlyMap<
        string,
        typeof orchestrator.subagents extends Map<string, infer V> ? V : never
      >;
    }),

    activeSubagents: computed(() => {
      void subagentVersion();
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.mapActiveSubagents(
        orchestrator.activeSubagents
      ) as readonly (typeof orchestrator.activeSubagents extends (infer V)[]
        ? V
        : never)[];
    }),

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

/**
 * @deprecated Use `injectStreamCustom` instead. `useStreamCustom` will be
 * removed in a future major version. `injectStreamCustom` follows Angular's
 * `inject*` naming convention for injection-based patterns.
 */
export const useStreamCustom = injectStreamCustom;
