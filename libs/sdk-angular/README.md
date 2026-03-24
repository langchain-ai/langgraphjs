# @langchain/angular

Angular SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It provides an `injectStream` function that manages streaming, state, branching, and interrupts using Angular's Signals API.

> **Migration note:** `useStream` has been renamed to `injectStream` to follow Angular's `inject*` naming convention. `useStream` is still available as a deprecated alias for backwards compatibility.

## Installation

```bash
npm install @langchain/angular @langchain/core
```

**Peer dependencies:** `@angular/core` (^18.0.0 - ^21.0.0), `@langchain/core` (^1.0.1)

## Quick Start

```typescript
import { Component } from "@angular/core";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

## `injectStream` Options

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required.** The assistant/graph ID to stream from. |
| `apiUrl` | `string` | Base URL of the LangGraph API. |
| `client` | `Client` | Pre-configured `Client` instance (alternative to `apiUrl`). |
| `messagesKey` | `string` | State key containing messages. Defaults to `"messages"`. |
| `initialValues` | `StateType` | Initial state values before any stream data arrives. |
| `fetchStateHistory` | `boolean \| { limit: number }` | Fetch thread history on stream completion. Enables branching. |
| `throttle` | `boolean \| number` | Throttle state updates for performance. |
| `onFinish` | `(state, error?) => void` | Called when the stream completes. |
| `onError` | `(error, state?) => void` | Called on stream errors. |
| `onThreadId` | `(threadId) => void` | Called when a new thread is created. |
| `onUpdateEvent` | `(event) => void` | Receive update events from the stream. |
| `onCustomEvent` | `(event) => void` | Receive custom events from the stream. |
| `onStop` | `() => void` | Called when the stream is stopped by the user. |

## Return Values

All reactive properties are Angular `Signal` or `WritableSignal` values.

| Property | Type | Description |
|---|---|---|
| `values` | `Signal<StateType>` | Current graph state. |
| `messages` | `Signal<Message[]>` | Messages from the current state. |
| `isLoading` | `Signal<boolean>` | Whether a stream is currently active. |
| `error` | `Signal<unknown>` | The most recent error, if any. |
| `interrupt` | `Signal<Interrupt \| undefined>` | Current interrupt requiring user input. |
| `branch` | `WritableSignal<string>` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. When called while a stream is active, the run is created on the server with `multitaskStrategy: "enqueue"` and queued automatically. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |
| `switchThread(id)` | `(id: string \| null) => void` | Switch to a different thread. Pass `null` to start a new thread on next submit. |
| `queue.entries` | `Signal<ReadonlyArray<QueueEntry>>` | Pending server-side runs. Each entry has `id` (server run ID), `values`, `options`, and `createdAt`. |
| `queue.size` | `Signal<number>` | Number of pending runs on the server. |
| `queue.cancel(id)` | `(id: string) => Promise<boolean>` | Cancel a pending run on the server by its run ID. |
| `queue.clear()` | `() => Promise<void>` | Cancel all pending runs on the server. |

## Type Safety

Provide your state type as a generic parameter:

```typescript
import type { BaseMessage } from "langchain";

interface MyState {
  messages: BaseMessage[];
  context?: string;
}

@Component({ /* ... */ })
export class ChatComponent {
  stream = injectStream<MyState>({
    assistantId: "my-graph",
    apiUrl: "http://localhost:2024",
  });
}
```

### Typed Interrupts

```typescript
import type { BaseMessage } from "langchain";

@Component({ /* ... */ })
export class ChatComponent {
  stream = injectStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "my-graph",
    apiUrl: "http://localhost:2024",
  });

  // this.stream.interrupt() is typed as { question: string } | undefined
}
```

## Handling Interrupts

```typescript
import { Component } from "@angular/core";
import type { BaseMessage } from "langchain";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      @if (stream.interrupt()) {
        <div>
          <p>{{ stream.interrupt()!.value.question }}</p>
          <button (click)="onResume()">Approve</button>
        </div>
      }

      <button (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ChatComponent {
  stream = injectStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello" }],
    });
  }

  onResume() {
    void this.stream.submit(null, { command: { resume: "Approved" } });
  }
}
```

## Branching

Enable conversation branching with `fetchStateHistory: true`:

```typescript
import { Component } from "@angular/core";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>
          <p>{{ str(msg.content) }}</p>

          @if (getBranchNav(msg, $index); as nav) {
            <button (click)="onPrev(nav)">Previous</button>
            <span>{{ nav.current + 1 }} / {{ nav.total }}</span>
            <button (click)="onNext(nav)">Next</button>
          }
        </div>
      }

      <button (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ChatComponent {
  stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    fetchStateHistory: true,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getBranchNav(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const options = metadata?.branchOptions;
    const branch = metadata?.branch;
    if (!options || !branch) return null;
    return {
      options,
      current: options.indexOf(branch),
      total: options.length,
    };
  }

  onPrev(nav: { options: string[]; current: number }) {
    const prev = nav.options[nav.current - 1];
    if (prev) this.stream.setBranch(prev);
  }

  onNext(nav: { options: string[]; current: number }) {
    const next = nav.options[nav.current + 1];
    if (next) this.stream.setBranch(next);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello" }],
    });
  }
}
```

## Server-Side Queuing

When `submit()` is called while a stream is already active, the SDK automatically creates the run on the server with `multitaskStrategy: "enqueue"`. The pending runs are tracked in `queue` and processed in order as each finishes:

```typescript
import { Component } from "@angular/core";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      @if (stream.queue.size() > 0) {
        <div>
          <p>{{ stream.queue.size() }} message(s) queued</p>
          <button (click)="onClearQueue()">Clear Queue</button>
        </div>
      }

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
      <button (click)="onNewThread()">New Thread</button>
    </div>
  `,
})
export class ChatComponent {
  stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }

  onClearQueue() {
    void this.stream.queue.clear();
  }

  onNewThread() {
    this.stream.switchThread(null);
  }
}
```

Switching threads via `switchThread()` cancels all pending runs and clears the queue.

## Service Pattern

For projects that prefer Angular's dependency injection, `StreamService` provides an `@Injectable()` base class that wraps `useStream`. Extend it with your own service to enable DI, testability, and shared state across components:

```typescript
import { Injectable, Component, inject } from "@angular/core";
import { StreamService } from "@langchain/angular";
import type { BaseMessage } from "langchain";

interface ChatState {
  messages: BaseMessage[];
}

@Injectable({ providedIn: "root" })
export class ChatService extends StreamService<ChatState> {
  constructor() {
    super({
      assistantId: "agent",
      apiUrl: "http://localhost:2024",
    });
  }
}

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of chat.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      <button
        [disabled]="chat.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  chat = inject(ChatService);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.chat.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

The service exposes the same signals and methods as `useStream` (`values`, `messages`, `isLoading`, `submit`, `stop`, etc.).

### Shared State Across Components

Because the service is provided through DI, multiple components can inject the same instance and share stream state:

```typescript
@Component({
  standalone: true,
  selector: "app-message-list",
  template: `
    @for (msg of chat.messages(); track msg.id ?? $index) {
      <div>{{ msg.content }}</div>
    }
  `,
})
export class MessageListComponent {
  chat = inject(ChatService);
}

@Component({
  standalone: true,
  imports: [MessageListComponent],
  template: `
    <app-message-list />
    <button (click)="onSubmit()">Send</button>
  `,
})
export class ChatPageComponent {
  chat = inject(ChatService);

  onSubmit() {
    void this.chat.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

### Custom Transport with StreamService

```typescript
import { Injectable } from "@angular/core";
import { StreamService, FetchStreamTransport } from "@langchain/angular";
import type { BaseMessage } from "langchain";

@Injectable({ providedIn: "root" })
export class CustomChatService extends StreamService<{
  messages: BaseMessage[];
}> {
  constructor() {
    super({
      transport: new FetchStreamTransport({
        url: "https://my-api.example.com/stream",
      }),
      threadId: null,
      onThreadId: (id) => console.log("Thread created:", id),
    });
  }
}
```

### Testing

Services can be mocked or overridden in tests using Angular's standard DI testing utilities:

```typescript
import { TestBed } from "@angular/core/testing";

const mockService = {
  messages: signal([]),
  isLoading: signal(false),
  submit: vi.fn(),
  stop: vi.fn(),
};

TestBed.configureTestingModule({
  providers: [{ provide: ChatService, useValue: mockService }],
});
```

## Custom Transport

Instead of connecting to a LangGraph API, you can provide your own streaming transport. Pass a `transport` object instead of `assistantId` to use a custom backend:

```typescript
import { Component } from "@angular/core";
import { injectStream, FetchStreamTransport } from "@langchain/angular";
import type { BaseMessage } from "langchain";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>
          <p>{{ str(msg.content) }}</p>
          @if (getStreamNode(msg, $index); as node) {
            <span>Node: {{ node }}</span>
          }
        </div>
      }

      <p>Current branch: {{ stream.branch() }}</p>

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  stream = injectStream<{ messages: BaseMessage[] }>({
    transport: new FetchStreamTransport({
      url: "https://my-api.example.com/stream",
    }),
    threadId: null,
    onThreadId: (id) => console.log("Thread created:", id),
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getStreamNode(msg: any, index: number): string | null {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    return (metadata?.streamMetadata as any)?.langgraph_node ?? null;
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

The custom transport interface returns the same properties as the standard `injectStream` function, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management. `onFinish` is also supported and receives a synthetic `ThreadState` built from the final locally streamed values; the run metadata argument is `undefined`.

## Sharing State with `provideStream`

When multiple components need the same stream (a message list, a header, an input bar), use `provideStream` and `injectStream` to share a single stream instance via Angular's dependency injection:

```typescript
import { Component } from "@angular/core";
import { provideStream, injectStream } from "@langchain/angular";

@Component({
  selector: "app-chat-container",
  providers: [provideStream({ assistantId: "agent", apiUrl: "http://localhost:2024" })],
  template: `
    <app-chat-header />
    <app-message-list />
    <app-message-input />
  `,
})
export class ChatContainerComponent {}

@Component({
  selector: "app-chat-header",
  template: `
    <header>
      <h1>Chat</h1>
      @if (stream.isLoading()) {
        <span>Thinking...</span>
      }
      @if (stream.error()) {
        <span>Error occurred</span>
      }
    </header>
  `,
})
export class ChatHeaderComponent {
  stream = injectStream();
}

@Component({
  selector: "app-message-list",
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }
  `,
})
export class MessageListComponent {
  stream = injectStream();

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}

@Component({
  selector: "app-message-input",
  template: `
    <button
      [disabled]="stream.isLoading()"
      (click)="onSubmit()"
    >Send</button>
  `,
})
export class MessageInputComponent {
  stream = injectStream();

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

### App-Level Configuration with `provideStreamDefaults`

Set default configuration for all `useStream` and `injectStream` calls application-wide:

```typescript
// app.config.ts
import { ApplicationConfig } from "@angular/core";
import { provideStreamDefaults } from "@langchain/angular";

export const appConfig: ApplicationConfig = {
  providers: [
    provideStreamDefaults({
      apiUrl: "http://localhost:2024",
    }),
  ],
};
```

Then in components, `apiUrl` is inherited automatically:

```typescript
@Component({
  providers: [provideStream({ assistantId: "agent" })],
  template: `...`,
})
export class ChatComponent {}
```

### Multiple Agents

Use separate `provideStream` entries on different components — Angular's hierarchical injector ensures each subtree gets its own isolated stream:

```typescript
@Component({
  selector: "app-research-panel",
  providers: [provideStream({ assistantId: "researcher", apiUrl: "http://localhost:2024" })],
  template: `<app-message-list /> <app-message-input />`,
})
export class ResearchPanelComponent {}

@Component({
  selector: "app-writer-panel",
  providers: [provideStream({ assistantId: "writer", apiUrl: "http://localhost:2024" })],
  template: `<app-message-list /> <app-message-input />`,
})
export class WriterPanelComponent {}
```

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
