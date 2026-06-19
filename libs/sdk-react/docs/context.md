# `StreamProvider` / `useStreamContext`

Share a single `useStream` instance across a subtree without prop drilling. `StreamProvider` accepts the same option shape as [`useStream`](./use-stream.md); `useStreamContext` reads the bound stream from any descendant.

## Table of contents

- [Basic usage](#basic-usage)
- [Type inference](#type-inference)
- [Nested providers (multi-agent layouts)](#nested-providers-multi-agent-layouts)
- [Custom adapters through `StreamProvider`](#custom-adapters-through-streamprovider)

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
      {error != null && <span>Error occurred</span>}
    </header>
  );
}
```

`StreamProvider` internally mounts `useStream` and publishes the handle on context. Companion selector hooks (`useMessages`, `useToolCalls`, etc.) work against the handle you pull from `useStreamContext`:

```tsx
import { useMessages, useStreamContext } from "@langchain/react";

function MessageList() {
  const stream = useStreamContext();
  const messages = useMessages(stream);
  return messages.map((m) => <Bubble key={m.id} msg={m} />);
}
```

## Type inference

Pass the agent brand to `useStreamContext` to flow state / tool-call / subagent inference through:

```tsx
import type { agent } from "./agent";

function Dashboard() {
  const stream = useStreamContext<typeof agent>();
  // stream.values, stream.toolCalls, stream.subagents are all typed
}
```

This is equivalent to calling `useStream<typeof agent>()` directly. See [Type safety](./type-safety.md) for the full inference story.

## Nested providers (multi-agent layouts)

`StreamProvider` works like any other React context provider — nesting is fine, and the innermost provider wins for descendants:

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

Each panel's descendants see its own stream handle.

## Custom adapters through `StreamProvider`

`StreamProvider` accepts the same discriminated option bag as `useStream`, so the custom-adapter branch is available here too:

```tsx
import { StreamProvider, HttpAgentServerAdapter } from "@langchain/react";

const transport = new HttpAgentServerAdapter({
  apiUrl: "/api/chat",
  threadId: "thread-123",
});

<StreamProvider transport={transport}>
  <App />
</StreamProvider>;
```

See [Transports](./transports.md) for details on the custom-adapter branch.
