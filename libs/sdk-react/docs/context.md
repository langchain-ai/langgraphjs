# `StreamProvider` and `useStreamContext`

Share one `useStream` across a component tree without passing it down. `StreamProvider` takes the same options as [`useStream`](./use-stream.md), and `useStreamContext` reads its stream from any component below it.

## Table of contents

- [Basic usage](#basic-usage)
- [Type inference](#type-inference)
- [Several providers](#several-providers)

## Basic usage

```tsx
import { StreamProvider, useStreamContext } from "@langchain/react";

function App() {
  return (
    <StreamProvider assistantId="agent" apiUrl="http://localhost:2024">
      <ChatHeader />
      <MessageList />
      <MessageInput />
    </StreamProvider>
  );
}

function ChatHeader() {
  const { isLoading, error } = useStreamContext();
  return (
    <header>
      {isLoading && <span>Thinking...</span>}
      {error != null && <span>Something went wrong</span>}
    </header>
  );
}
```

The [selector hooks](./selectors.md) take the stream `useStreamContext` returns:

```tsx
import { useMessages, useStreamContext } from "@langchain/react";

function MessageList() {
  const stream = useStreamContext();
  const messages = useMessages(stream);
  return messages.map((message, i) => (
    <div key={message.id ?? i}>{message.text}</div>
  ));
}
```

`useStreamContext` throws outside a `StreamProvider`.

## Type inference

Pass your agent's type to `useStreamContext` to type the stream:

```tsx
import type { agent } from "./agent";

function Dashboard() {
  const stream = useStreamContext<typeof agent>();
  // stream.values, stream.toolCalls and stream.subagents are typed
}
```

It types the stream as `useStream<typeof agent>()` would. See [Type safety](./type-safety.md).

## Several providers

Providers nest like any React context: each component reads the closest one above it.

```tsx
<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
  <StreamProvider assistantId="researcher" apiUrl="http://localhost:2024">
    <ResearchPanel />
  </StreamProvider>
  <StreamProvider assistantId="writer" apiUrl="http://localhost:2024">
    <WriterPanel />
  </StreamProvider>
</div>
```

A provider can also take a custom `transport` instead of `apiUrl`: see [Custom transports](./custom-transport.md).
