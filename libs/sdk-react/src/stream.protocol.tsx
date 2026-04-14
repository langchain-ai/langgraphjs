/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import type { Interrupt, BagTemplate } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk/client";
import type {
  AnyStreamOptions,
  GetInterruptType,
  GetUpdateType,
  GetConfigurableType,
  GetCustomEventType,
} from "@langchain/langgraph-sdk/ui";
import { normalizeInterruptsList } from "@langchain/langgraph-sdk/ui";
import { useStreamLGP } from "./stream.lgp.js";
import { ProtocolStreamRuntime } from "./stream-runtime/runtime.js";
import type { UseStream, SubmitOptions } from "./types.js";
import type { StreamRuntime } from "./stream-runtime/types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

class ProtocolInterruptStore<InterruptType> {
  private interrupts: Interrupt<InterruptType>[] = [];

  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.interrupts;

  clear = () => {
    if (this.interrupts.length === 0) return;
    this.interrupts = [];
    this.listeners.forEach((listener) => listener());
  };

  merge = (interrupt: Interrupt<InterruptType>) => {
    if (
      interrupt.id != null &&
      this.interrupts.some((entry) => entry.id === interrupt.id)
    ) {
      return;
    }
    this.interrupts = [...this.interrupts, interrupt];
    this.listeners.forEach((listener) => listener());
  };
}

async function* stripInputEvents<InterruptType>(
  source: AsyncGenerator<{ id?: string; event: string; data: unknown }>,
  store: ProtocolInterruptStore<InterruptType>
): AsyncGenerator<{ id?: string; event: string; data: unknown }> {
  for await (const item of source) {
    if (item.event === "input" || item.event.startsWith("input|")) {
      const namespace = item.event.includes("|")
        ? item.event.split("|").slice(1)
        : [];
      if (
        namespace.length === 0 &&
        isRecord(item.data) &&
        typeof item.data.interruptId === "string"
      ) {
        store.merge({
          id: item.data.interruptId,
          value: item.data.payload,
        } as Interrupt<InterruptType>);
      }
      continue;
    }

    yield item;
  }
}

/**
 * Wraps a `Client` so that `runs.stream()` delegates to the protocol runtime
 * (which keeps the session alive for `input.respond`) and strips `input`
 * events before they reach `StreamManager`. `runs.joinStream()` also strips
 * `input` events but delegates to the original client since join doesn't
 * need a persistent session.
 */
function createInterceptedClient<InterruptType>(
  original: Client,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: StreamRuntime<any, any, any, any>,
  store: ProtocolInterruptStore<InterruptType>
): Client {
  const intercepted = Object.create(original) as Client;
  intercepted.runs = Object.create(original.runs) as Client["runs"];

  const originalStream = original.runs.stream.bind(original.runs);
  intercepted.runs.stream = ((
    threadId: string | null,
    assistantId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any
  ) => {
    store.clear();
    const gen = runtime.submit({
      assistantId,
      threadId: threadId ?? "",
      input: payload?.input ?? null,
      submitOptions: payload,
      signal: payload?.signal ?? new AbortController().signal,
      streamMode: Array.isArray(payload?.streamMode)
        ? payload.streamMode
        : payload?.streamMode
          ? [payload.streamMode]
          : [],
      onRunCreated: payload?.onRunCreated,
    });
    return (async function* () {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yield* stripInputEvents((await gen) as any, store) as any;
    })();
  }) as typeof originalStream;

  const originalJoinStream = original.runs.joinStream.bind(original.runs);
  intercepted.runs.joinStream = ((
    threadId: string,
    runId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any
  ) => {
    store.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return stripInputEvents(
      originalJoinStream(threadId, runId, payload) as any,
      store
    );
  }) as typeof originalJoinStream;

  return intercepted;
}

/**
 * Wraps `useStreamLGP` with v2 protocol-specific behavior:
 * - Routes `runs.stream()` through the protocol runtime (session-based transport)
 * - Intercepts `input` stream events and stores them as protocol interrupts
 * - Routes `submit({ command: { resume } })` through `input.respond`
 * - Exposes protocol interrupts via `interrupts` / `interrupt` getters
 *
 * The legacy hook receives a client whose `runs.stream()` delegates to the
 * protocol runtime, so it needs zero protocol awareness.
 */
export function useStreamProtocol<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>): UseStream<StateType, Bag> {
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type CustomType = GetCustomEventType<Bag>;

  const [interruptStore] = useState(
    () => new ProtocolInterruptStore<InterruptType>()
  );

  const protocolInterrupts = useSyncExternalStore(
    interruptStore.subscribe,
    interruptStore.getSnapshot,
    interruptStore.getSnapshot
  );

  const originalClient = useMemo(
    () =>
      (options.client as Client | undefined) ??
      new Client({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        callerOptions: options.callerOptions,
        defaultHeaders: options.defaultHeaders,
        streamProtocol: options.streamProtocol,
      }),
    [
      options.client,
      options.apiKey,
      options.apiUrl,
      options.callerOptions,
      options.defaultHeaders,
      options.streamProtocol,
    ]
  );

  const protocolRuntime = useMemo(
    () =>
      new ProtocolStreamRuntime<
        StateType,
        GetUpdateType<Bag, StateType>,
        ConfigurableType,
        CustomType
      >(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        originalClient as any,
        options.streamProtocol,
        {
          protocolFetch: options.protocolFetch?.(),
          protocolWebSocket: options.protocolWebSocket,
        }
      ),
    [
      originalClient,
      options.streamProtocol,
      options.protocolFetch,
      options.protocolWebSocket,
    ]
  );

  const interceptedClient = useMemo(
    () =>
      createInterceptedClient(originalClient, protocolRuntime, interruptStore),
    [originalClient, protocolRuntime, interruptStore]
  );

  const base = useStreamLGP<StateType, Bag>({
    ...options,
    client: interceptedClient,
  });

  const submit = async (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) => {
    interruptStore.clear();
    return base.submit(values, submitOptions);
  };

  return Object.defineProperties(Object.create(base), {
    submit: { value: submit, enumerable: true },
    interrupts: {
      get(): Interrupt<InterruptType>[] {
        if (protocolInterrupts.length > 0) {
          return normalizeInterruptsList(protocolInterrupts);
        }
        return base.interrupts;
      },
      enumerable: true,
    },
    interrupt: {
      get() {
        if (protocolInterrupts.length === 1) {
          return normalizeInterruptsList(protocolInterrupts)[0];
        }
        if (protocolInterrupts.length > 1) {
          return normalizeInterruptsList(
            protocolInterrupts
          ) as Interrupt<InterruptType>;
        }
        return base.interrupt;
      },
      enumerable: true,
    },
  }) as UseStream<StateType, Bag>;
}
