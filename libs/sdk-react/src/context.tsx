/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  useStream,
  type UseStreamOptions,
  type UseStreamReturn,
  type AgentServerOptions,
  type CustomAdapterOptions,
} from "./use-stream.js";
import type { InferStateType } from "@langchain/langgraph-sdk/stream";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StreamContext = createContext<any | null>(null);

/**
 * Props for {@link StreamProvider} when talking to the default
 * LangGraph Platform agent server. Mirrors {@link AgentServerOptions}
 * plus `children`.
 */
export type StreamProviderProps<T = Record<string, unknown>> =
  AgentServerOptions<InferStateType<T>> & {
    children: ReactNode;
  };

/**
 * Props for {@link StreamProvider} when wiring a custom
 * {@link AgentServerAdapter}. Mirrors {@link CustomAdapterOptions}
 * plus `children`.
 */
export type StreamProviderCustomProps<T = Record<string, unknown>> =
  CustomAdapterOptions<InferStateType<T>> & {
    children: ReactNode;
  };

/**
 * Provides a shared {@link useStream} instance to all descendants via
 * React Context.
 *
 * Use `StreamProvider` when multiple components in a subtree need
 * access to the same stream state (messages, loading status, errors,
 * interrupts, …) without prop drilling.
 *
 * @example
 * ```tsx
 * import { StreamProvider, useStreamContext } from "@langchain/react";
 *
 * function App() {
 *   return (
 *     <StreamProvider assistantId="agent" apiUrl="http://localhost:2024">
 *       <ChatHeader />
 *       <MessageList />
 *       <MessageInput />
 *     </StreamProvider>
 *   );
 * }
 *
 * function ChatHeader() {
 *   const { isLoading, error } = useStreamContext();
 *   return (
 *     <header>
 *       {isLoading && <span>Thinking...</span>}
 *       {error && <span>Error</span>}
 *     </header>
 *   );
 * }
 * ```
 *
 * Multiple providers can be nested for multi-agent scenarios:
 *
 * @example
 * ```tsx
 * <StreamProvider assistantId="researcher" apiUrl="http://localhost:2024">
 *   <ResearchPanel />
 * </StreamProvider>
 * <StreamProvider assistantId="writer" apiUrl="http://localhost:2024">
 *   <WriterPanel />
 * </StreamProvider>
 * ```
 */
export function StreamProvider<T = Record<string, unknown>>(
  props: StreamProviderProps<T> | StreamProviderCustomProps<T>
): ReactNode {
  const { children, ...options } = props;
  const stream = useStream<T>(options as UseStreamOptions<InferStateType<T>>);

  return (
    <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
  );
}

/**
 * Accesses the shared stream instance from the nearest
 * {@link StreamProvider}. Throws if called outside of one.
 *
 * @example
 * ```tsx
 * function MessageList() {
 *   const { messages } = useStreamContext();
 *   return messages.map((m, i) => <div key={m.id ?? i}>{String(m.content)}</div>);
 * }
 * ```
 *
 * @example With a type parameter for full type safety:
 * ```tsx
 * import type { agent } from "./agent";
 *
 * function Chat() {
 *   const { toolCalls } = useStreamContext<typeof agent>();
 * }
 * ```
 */
export function useStreamContext<
  T = Record<string, unknown>,
>(): UseStreamReturn<T> {
  const context = useContext(StreamContext);
  if (context === null) {
    throw new Error(
      "useStreamContext must be used within a <StreamProvider>. " +
        "Wrap your component tree with <StreamProvider> or use useStream() directly."
    );
  }
  return context as UseStreamReturn<T>;
}
