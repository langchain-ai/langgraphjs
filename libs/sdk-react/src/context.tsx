/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { BagTemplate } from "@langchain/langgraph-sdk";
import type {
  ResolveStreamOptions,
  InferBag,
  InferStateType,
  UseStreamCustomOptions,
} from "@langchain/langgraph-sdk/ui";
import { useStream } from "./stream.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StreamContext = createContext<any | null>(null);

/**
 * Props for the StreamProvider component.
 * Accepts all `useStream` options plus `children`.
 */
export type StreamProviderProps<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> = ResolveStreamOptions<T, InferBag<T, Bag>> & { children: ReactNode };

/**
 * Props for the StreamProvider component when using a custom transport.
 * Accepts all `useStream` custom options plus `children`.
 */
export type StreamProviderCustomProps<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> = UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>> & {
  children: ReactNode;
};

/**
 * Provides a shared `useStream` instance to all descendants via React Context.
 *
 * Use `StreamProvider` when multiple components in a subtree need access to the
 * same stream state (messages, loading status, errors, interrupts, etc.) without
 * prop drilling.
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
 *
 * function MessageList() {
 *   const { messages } = useStreamContext();
 *   return messages.map((msg, i) => <div key={msg.id ?? i}>{msg.content}</div>);
 * }
 *
 * function MessageInput() {
 *   const { submit } = useStreamContext();
 *   return (
 *     <button onClick={() => submit({ messages: [{ type: "human", content: "Hi" }] })}>
 *       Send
 *     </button>
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
export function StreamProvider<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  props: StreamProviderProps<T, Bag> | StreamProviderCustomProps<T, Bag>
): ReactNode {
  const { children, ...options } = props;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = useStream<T, Bag>(options as any);

  return (
    <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
  );
}

/**
 * Accesses the shared stream instance from the nearest `StreamProvider`.
 *
 * Throws if called outside of a `StreamProvider`.
 *
 * @example
 * ```tsx
 * function MessageList() {
 *   const { messages, getMessagesMetadata } = useStreamContext();
 *   return messages.map((msg, i) => {
 *     const metadata = getMessagesMetadata(msg, i);
 *     return <div key={msg.id ?? i}>{msg.content}</div>;
 *   });
 * }
 * ```
 *
 * @example With type parameters for full type safety:
 * ```tsx
 * import type { agent } from "./agent";
 *
 * function Chat() {
 *   const { toolCalls } = useStreamContext<typeof agent>();
 *   // toolCalls are fully typed from the agent's tools
 * }
 * ```
 */
export function useStreamContext<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  const context = useContext(StreamContext);
  if (context === null) {
    throw new Error(
      "useStreamContext must be used within a <StreamProvider>. " +
        "Wrap your component tree with <StreamProvider> or use useStream() directly."
    );
  }
  return context;
}
