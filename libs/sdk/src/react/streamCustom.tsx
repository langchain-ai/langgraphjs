/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useState, useSyncExternalStore } from "react";
import { EventStreamEvent, StreamManager } from "./manager.js";
import type {
  BagTemplate,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  RunCallbackMeta,
  SubmitOptions,
  GetConfigurableType,
} from "./types.js";
import type { Message } from "../types.messages.js";
import type {
  CheckpointsStreamEvent,
  CustomStreamEvent,
  DebugStreamEvent,
  EventsStreamEvent,
  MetadataStreamEvent,
  TasksStreamEvent,
  UpdatesStreamEvent,
} from "../types.stream.js";
import { MessageTupleManager } from "./messages.js";
import { Interrupt } from "../schema.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import { IterableReadableStream } from "../utils/stream.js";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: {
  /**
   * The URL of the API to use.
   */
  apiUrl: string;

  /**
   * Specify the key within the state that contains messages.
   * Defaults to "messages".
   *
   * @default "messages"
   */
  messagesKey?: string;

  /**
   * Callback that is called when an error occurs.
   */
  onError?: (error: unknown, run: RunCallbackMeta | undefined) => void;

  /**
   * Callback that is called when a new stream is created.
   */
  onCreated?: (run: RunCallbackMeta) => void;

  /**
   * Callback that is called when an update event is received.
   */
  onUpdateEvent?: (
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a custom event is received.
   */
  onCustomEvent?: (
    data: CustomStreamEvent<GetCustomEventType<Bag>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a metadata event is received.
   */
  onMetadataEvent?: (data: MetadataStreamEvent["data"]) => void;

  /**
   * Callback that is called when a LangChain event is received.
   * @see https://langchain-ai.github.io/langgraph/cloud/how-tos/stream_events/#stream-graph-in-events-mode for more details.
   */
  onLangChainEvent?: (data: EventsStreamEvent["data"]) => void;

  /**
   * Callback that is called when a debug event is received.
   * @internal This API is experimental and subject to change.
   */
  onDebugEvent?: (
    data: DebugStreamEvent["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a checkpoints event is received.
   */
  onCheckpointEvent?: (
    data: CheckpointsStreamEvent<StateType>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a tasks event is received.
   */
  onTaskEvent?: (
    data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when the stream is stopped by the user.
   * Provides a mutate function to update the stream state immediately
   * without requiring a server roundtrip.
   *
   * @example
   * ```typescript
   * onStop: ({ mutate }) => {
   *   mutate((prev) => ({
   *     ...prev,
   *     ui: prev.ui?.map(component =>
   *       component.props.isLoading
   *         ? { ...component, props: { ...component.props, stopped: true, isLoading: false }}
   *         : component
   *     )
   *   }));
   * }
   * ```
   */
  onStop?: (options: {
    mutate: (
      update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    ) => void;
  }) => void;

  /**
   * Initial values to display immediately when loading a thread.
   * Useful for displaying cached thread data while official history loads.
   * These values will be replaced when official thread data is fetched.
   *
   * Note: UI components from initialValues will render immediately if they're
   * predefined in LoadExternalComponent's components prop, providing instant
   * cached UI display without server fetches.
   */
  initialValues?: StateType | null;
}) {
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

  // --- TRANSPORT ---
  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) => {
    let callbackMeta: RunCallbackMeta | undefined;

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
        const response = await fetch(options.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
          signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to stream: ${response.statusText}`);
        }

        const stream = (
          response.body || new ReadableStream({ start: (ctrl) => ctrl.close() })
        )
          .pipeThrough(BytesLineDecoder())
          .pipeThrough(SSEDecoder());

        return IterableReadableStream.fromReadableStream(
          stream
        ) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
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
  // --- END TRANSPORT ---

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

    get messages() {
      if (!stream.values) return [];
      return getMessages(stream.values);
    },
  };
}
