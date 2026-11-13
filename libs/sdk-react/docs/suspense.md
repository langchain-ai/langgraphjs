# `useSuspenseStream`

`useSuspenseStream` is [`useStream`](./use-stream.md) for React Suspense: the component suspends while its thread loads, and a thread that fails to load goes to the nearest error boundary.

## Table of contents

- [Basic usage](#basic-usage)
- [What it returns](#what-it-returns)
- [Errors](#errors)
- [Server rendering](#server-rendering)
- [Thread switches](#thread-switches)

## Basic usage

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";

function App() {
  return (
    <ErrorBoundary fallback={<ErrorDisplay />}>
      <Suspense fallback={<Spinner />}>
        <Chat threadId={threadId} />
      </Suspense>
    </ErrorBoundary>
  );
}

function Chat({ threadId }: { threadId: string | null }) {
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId,
  });

  return (
    <>
      {messages.map((message, i) => (
        <div key={message.id ?? i}>{message.text}</div>
      ))}
      {isStreaming && <TypingIndicator />}
    </>
  );
}
```

The thread is read once, also when the component suspends before it mounts.

## What it returns

The same as `useStream`, with two differences:

- no `isLoading`, `isThreadLoading` or `hydrationPromise`, since Suspense shows the load,
- `isStreaming`, which is `true` while a run streams.

The [selector hooks](./selectors.md) accept its result, as they accept `useStream`'s.

## Errors

- A thread that fails to load throws to the nearest error boundary.
- A run that fails sets `error` and throws nothing, so the conversation stays on screen. To send it to the error boundary too, throw it yourself: `if (error) throw error;`.

## Server rendering

A server render, in Next.js and the like, reads no thread, since the user's auth is in the browser. There `useSuspenseStream` throws an error whose `digest` is `"BAILOUT_TO_CLIENT_SIDE_RENDERING"`, Next.js's mark for rendering on the client: React renders the Suspense fallback on the server, and the component in the browser, which loads the thread. Next.js doesn't report that error. [`useStream`](./use-stream.md) throws nothing there: it shows the `threadId` it's given as loading. With a [custom transport](./custom-transport.md) there is no thread to read, so both hooks render on the server as they do in the browser.

With another framework, React reports the error twice: to the server render's `onError`, and to the browser's `onRecoverableError` when it hydrates the fallback. Skip it in both. The browser sees the `digest` only when the server's `onError` returns it:

```tsx
const CLIENT_RENDERING = "BAILOUT_TO_CLIENT_SIDE_RENDERING";
const digestOf = (error: unknown) =>
  (error as { digest?: unknown } | null)?.digest;

// On the server
const html = await renderToReadableStream(<App />, {
  onError(error) {
    if (digestOf(error) === CLIENT_RENDERING) return CLIENT_RENDERING;
    console.error(error);
    return undefined;
  },
});

// In the browser
hydrateRoot(document, <App />, {
  onRecoverableError(error) {
    if (digestOf(error) !== CLIENT_RENDERING) console.error(error);
  },
});
```

## Thread switches

A new `threadId` suspends the component again while that thread loads:

```tsx
<Suspense fallback={<Spinner />}>
  <Chat threadId={selectedThreadId} />
</Suspense>
```

To drive your own loading UI instead, use [`useStream`](./use-stream.md) and its `isThreadLoading` and `hydrationPromise`.
