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
  GetConfigurableType,
  UseStreamCustomOptions,
  UseStreamCustom,
  CustomSubmitOptions,
} from "./types.js";
import type { Message } from "../types.messages.js";
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
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
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
