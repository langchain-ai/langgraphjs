/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetToolCallsType,
  RunCallbackMeta,
  GetConfigurableType,
  UseStreamTransport,
  UseStreamCustomOptions,
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
import { getUIMessagesWithReasoning } from "./utils.js";
import type { BagTemplate } from "../types.template.js";
import {
  isBrowserToolInterrupt,
  handleBrowserToolInterrupt,
} from "../browser-tools.js";

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
  options: UseStreamCustomOptions<StateType, Bag>
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

  const getMessages = useCallback(
    (value: StateType): Message[] => {
      const messagesKey = options.messagesKey ?? "messages";
      return Array.isArray(value[messagesKey])
        ? (value[messagesKey] as Message[])
        : [];
    },
    [options.messagesKey]
  );

  const setMessages = useCallback(
    (current: StateType, messages: Message[]): StateType => {
      const messagesKey = options.messagesKey ?? "messages";
      return { ...current, [messagesKey]: messages };
    },
    [options.messagesKey]
  );

  const historyValues = useMemo(() => {
    return options.initialValues ?? ({} as StateType);
  }, [options.initialValues]);

  const stop = () => stream.stop(historyValues, { onStop: options.onStop });

  const submit = useCallback(
    async (
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
    },
    [
      threadId,
      stream,
      getMessages,
      setMessages,
      options,
      historyValues,
      onThreadId,
    ]
  );

  // Browser tools handling
  const browserToolsRef = useRef(options.browserTools);
  browserToolsRef.current = options.browserTools;

  const onBrowserToolRef = useRef(options.onBrowserTool);
  onBrowserToolRef.current = options.onBrowserTool;

  // Track which browser tool interrupts have been handled to prevent duplicates
  const handledBrowserToolsRef = useRef<Set<string>>(new Set());

  // Reset handled browser tools when thread changes
  useEffect(() => {
    handledBrowserToolsRef.current.clear();
  }, [threadId]);

  // Handle browser tool interrupts
  useEffect(() => {
    const browserTools = browserToolsRef.current;
    if (!browserTools?.length) return;
    if (!stream.values) return;

    // Check for browser tool interrupt in values
    const interrupts = stream.values.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return;

    // Find browser tool interrupts that haven't been handled
    for (const interrupt of interrupts) {
      if (!isBrowserToolInterrupt(interrupt.value)) continue;

      const interruptId = interrupt.id ?? interrupt.value.toolCall.id ?? "";
      if (handledBrowserToolsRef.current.has(interruptId)) continue;

      // Mark as handled before async operation
      handledBrowserToolsRef.current.add(interruptId);

      // Handle the browser tool interrupt
      void handleBrowserToolInterrupt(
        interrupt.value,
        browserTools,
        onBrowserToolRef.current
      ).then((result) => {
        // Resume with the tool result
        void submit(null, {
          command: {
            resume: result.toolCallId
              ? { [result.toolCallId]: result.value }
              : result.value,
          },
        });
      });
    }
  }, [stream.values, submit]);

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

    get uiMessages() {
      if (!stream.values) return [];
      const msgs = getMessages(stream.values);
      return getUIMessagesWithReasoning<ToolCallType>(msgs);
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
  };
}
