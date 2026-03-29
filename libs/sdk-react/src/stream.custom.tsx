/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CustomStreamOrchestrator,
  FetchStreamTransport,
  type GetUpdateType,
  type GetInterruptType,
  type GetToolCallsType,
  type GetConfigurableType,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
  type MessageMetadata,
} from "@langchain/langgraph-sdk/ui";
import type { BaseMessage } from "@langchain/core/messages";
import type { BagTemplate, Message, Interrupt } from "@langchain/langgraph-sdk";
import { useControllableThreadId } from "./thread.js";
import type { UseStreamCustom } from "./types.js";

export { FetchStreamTransport };

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: AnyStreamCustomOptions<StateType, Bag>,
): UseStreamCustom<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type ToolCallType = GetToolCallsType<StateType>;

  const [threadId, onThreadId] = useControllableThreadId(options);
  const orchestratorOptions = useMemo(
    () => ({
      ...options,
      threadId,
      onThreadId,
    }),
    [options, threadId, onThreadId],
  );
  const [orchestrator] = useState(
    () => new CustomStreamOrchestrator<StateType, Bag>(orchestratorOptions),
  );
  const [, forceRender] = useState(0);

  useEffect(() => {
    orchestrator.syncThreadId(threadId);
  }, [orchestrator, threadId]);

  useEffect(() => {
    const unsubscribe = orchestrator.subscribe(() => {
      forceRender((v) => v + 1);
    });
    return () => unsubscribe();
  }, [orchestrator]);

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) => {
    await orchestrator.submit(values, submitOptions);
  };

  return {
    get values() {
      return orchestrator.values ?? ({} as StateType);
    },

    error: orchestrator.error,
    isLoading: orchestrator.isLoading,

    stop: () => orchestrator.stop(),
    submit,
    switchThread(newThreadId: string | null) {
      if (newThreadId !== threadId) {
        orchestrator.switchThread(newThreadId);
        onThreadId(newThreadId);
      }
    },

    branch: orchestrator.branch,
    setBranch: (value: string) => orchestrator.setBranch(value),

    getMessagesMetadata(
      message: BaseMessage,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message as Message, index);
    },

    get interrupts(): Interrupt<InterruptType>[] {
      return orchestrator.interrupts as Interrupt<InterruptType>[];
    },

    get interrupt(): Interrupt<InterruptType> | undefined {
      return orchestrator.interrupt as Interrupt<InterruptType> | undefined;
    },

    get messages(): BaseMessage[] {
      return orchestrator.messages as BaseMessage[];
    },

    get toolCalls() {
      return orchestrator.toolCalls as ReturnType<typeof orchestrator.getToolCalls>;
    },

    getToolCalls(message) {
      return orchestrator.getToolCalls(message as Message);
    },

    get subagents() {
      return orchestrator.subagents;
    },

    get activeSubagents() {
      return orchestrator.activeSubagents;
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

    queue: {
      get entries() {
        return orchestrator.queueEntries;
      },
      get size() {
        return orchestrator.queueSize;
      },
      async cancel(id: string) {
        return orchestrator.cancelQueueItem(id);
      },
      async clear() {
        await orchestrator.clearQueue();
      },
    },
  };
}
