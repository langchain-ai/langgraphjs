/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  BagTemplate,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  RunCallbackMeta,
  GetConfigurableType,
  UseStreamTransport,
} from "../ui/types.js";
import type {
  UseStreamCustomOptions,
  UseStreamCustom,
  CustomSubmitOptions,
} from "./types.js";
import type { Message } from "../types.messages.js";
import { MessageTupleManager } from "../ui/messages.js";
import { Interrupt } from "../schema.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import { IterableReadableStream } from "../utils/stream.js";
import { useControllableThreadId } from "./thread.js";
import { Command } from "../types.js";
import { extractInterrupts } from "../ui/interrupts.js";

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
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options: UseStreamCustomOptions<StateType, Bag>
): UseStreamCustom<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const [messageManager] = useState(() => new MessageTupleManager());
  const [stream] = useState(
    () => new StreamManager<StateType, Bag>(messageManager)
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
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const historyValues = options.initialValues ?? ({} as StateType);

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
      return extractInterrupts<InterruptType>(stream.values);
    },

    get messages() {
      if (!stream.values) return [];
      return getMessages(stream.values);
    },
  };
}
