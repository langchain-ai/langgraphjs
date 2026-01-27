/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetToolCallsType,
  RunCallbackMeta,
  GetConfigurableType,
  UseStreamTransport,
  AnyStreamCustomOptions,
  CustomSubmitOptions,
} from "../ui/types.js";
import type { UseStreamCustom } from "./types.js";
import { type Message } from "../types.messages.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import { MessageTupleManager } from "../ui/messages.js";
import { Interrupt } from "../schema.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import { IterableReadableStream } from "../utils/stream.js";
import { useControllableThreadId } from "./thread.js";
import { Command } from "../types.js";
import type { BagTemplate } from "../types.template.js";

interface FetchStreamTransportOptions {
  /**
   * The URL of the API to use.
   */
  apiUrl: string;

  /**
   * Default headers to send with requests.
   */
  defaultHeaders?: HeadersInit;

  /**
   * Specify a custom fetch implementation.
   */
  fetch?: typeof fetch | ((...args: any[]) => any); // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Callback that is called before the request is made.
   */
  onRequest?: (
    url: string,
    init: RequestInit
  ) => Promise<RequestInit> | RequestInit;
}

export class FetchStreamTransport<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> implements UseStreamTransport<StateType, Bag>
{
  constructor(private readonly options: FetchStreamTransportOptions) {}

  async stream(payload: {
    input: GetUpdateType<Bag, StateType> | null | undefined;
    context: GetConfigurableType<Bag> | undefined;
    command: Command | undefined;
    signal: AbortSignal;
  }): Promise<AsyncGenerator<{ id?: string; event: string; data: unknown }>> {
    const { signal, ...body } = payload;

    let requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.options.defaultHeaders,
      },
      body: JSON.stringify(body),
      signal,
    };

    if (this.options.onRequest) {
      requestInit = await this.options.onRequest(
        this.options.apiUrl,
        requestInit
      );
    }
    const fetchFn = this.options.fetch ?? fetch;

    const response = await fetchFn(this.options.apiUrl, requestInit);
    if (!response.ok) {
      throw new Error(`Failed to stream: ${response.statusText}`);
    }

    const stream = (
      response.body || new ReadableStream({ start: (ctrl) => ctrl.close() })
    )
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    return IterableReadableStream.fromReadableStream(stream);
  }
}

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: AnyStreamCustomOptions<StateType, Bag>
): UseStreamCustom<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type ToolCallType = GetToolCallsType<StateType>;

  const [messageManager] = useState(() => new MessageTupleManager());
  const [stream] = useState(
    () =>
      new StreamManager<StateType, Bag>(messageManager, {
        throttle: options.throttle ?? false,
        subagentToolNames: options.subagentToolNames,
        filterSubagentMessages: options.filterSubagentMessages,
      })
  );

  useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot
  );

  const [threadId, onThreadId] = useControllableThreadId(options);
  const threadIdRef = useRef<string | null>(threadId);

  // Cancel the stream if thread ID has changed
  useEffect(() => {
    if (threadIdRef.current !== threadId) {
      threadIdRef.current = threadId;
      stream.clear();
    }
  }, [threadId, stream]);

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey])
      ? (value[messagesKey] as Message[])
      : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const historyValues = options.initialValues ?? ({} as StateType);

  // Reconstruct subagents from initialValues when:
  // 1. Subagent filtering is enabled
  // 2. Not currently streaming
  // 3. initialValues has messages
  // This ensures subagent visualization works with cached/persisted state
  const historyMessages = getMessages(historyValues);
  const shouldReconstructSubagents =
    options.filterSubagentMessages &&
    !stream.isLoading &&
    historyMessages.length > 0;

  useEffect(() => {
    if (shouldReconstructSubagents) {
      // skipIfPopulated: true ensures we don't overwrite subagents from active streaming
      stream.reconstructSubagents(historyMessages, { skipIfPopulated: true });
    }
    // We intentionally only run this when shouldReconstructSubagents changes
    // to avoid unnecessary reconstructions during streaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldReconstructSubagents, historyMessages.length]);

  const stop = () => stream.stop(historyValues, { onStop: options.onStop });

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
  ) => {
    let callbackMeta: RunCallbackMeta | undefined;
    let usableThreadId = threadId;

    stream.setStreamValues(() => {
      if (submitOptions?.optimisticValues != null) {
        return {
          ...historyValues,
          ...(typeof submitOptions.optimisticValues === "function"
            ? submitOptions.optimisticValues(historyValues)
            : submitOptions.optimisticValues),
        };
      }

      return { ...historyValues };
    });

    await stream.start(
      async (signal: AbortSignal) => {
        if (!usableThreadId) {
          // generate random thread id
          usableThreadId = crypto.randomUUID();
          threadIdRef.current = usableThreadId;
          onThreadId(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return options.transport.stream({
          input: values,
          context: submitOptions?.context,
          command: submitOptions?.command,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: {
              thread_id: usableThreadId,
              ...submitOptions?.config?.configurable,
            } as unknown as GetConfigurableType<Bag>,
          },
        }) as Promise<
          AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
        >;
      },
      {
        getMessages,
        setMessages,

        initialValues: {} as StateType,
        callbacks: options,

        onSuccess: () => undefined,
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
      }
    );
  };

  return {
    get values() {
      return stream.values ?? ({} as StateType);
    },

    error: stream.error,
    isLoading: stream.isLoading,

    stop,
    submit,

    get interrupt(): Interrupt<InterruptType> | undefined {
      if (
        stream.values != null &&
        "__interrupt__" in stream.values &&
        Array.isArray(stream.values.__interrupt__)
      ) {
        const valueInterrupts = stream.values.__interrupt__;
        if (valueInterrupts.length === 0) return { when: "breakpoint" };
        if (valueInterrupts.length === 1) return valueInterrupts[0];

        // TODO: fix the typing of interrupts if multiple interrupts are returned
        return valueInterrupts as Interrupt<InterruptType>;
      }

      return undefined;
    },

    get messages(): Message<ToolCallType>[] {
      if (!stream.values) return [];
      return getMessages(stream.values);
    },

    get toolCalls() {
      if (!stream.values) return [];
      const msgs = getMessages(stream.values);
      return getToolCallsWithResults<ToolCallType>(msgs);
    },

    getToolCalls(message) {
      if (!stream.values) return [];
      const msgs = getMessages(stream.values);
      const allToolCalls = getToolCallsWithResults<ToolCallType>(msgs);
      return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
    },

    get subagents() {
      return stream.getSubagents();
    },

    get activeSubagents() {
      return stream.getActiveSubagents();
    },

    getSubagent(toolCallId: string) {
      return stream.getSubagent(toolCallId);
    },

    getSubagentsByType(type: string) {
      return stream.getSubagentsByType(type);
    },
  };
}
