# Dependency injection

`@langchain/angular` exposes three DI primitives so a stream can be
shared across a subtree, configured globally, or wrapped in a
class-based service.

## `provideStream` / `injectStreamContext`

When multiple components need the same stream (a header, a message
list, an input bar), publish a single instance through Angular DI:

```typescript
import { Component } from "@angular/core";
import { injectStreamContext, provideStream } from "@langchain/angular";

@Component({
  standalone: true,
  selector: "app-chat-container",
  providers: [
    provideStream({
      assistantId: "agent",
      apiUrl: "http://localhost:2024",
    }),
  ],
  template: `
    <app-chat-header />
    <app-message-list />
    <app-message-input />
  `,
})
export class ChatContainerComponent {}

@Component({
  standalone: true,
  selector: "app-message-list",
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }
  `,
})
export class MessageListComponent {
  readonly stream = injectStreamContext();

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}
```

`injectStreamContext()` throws synchronously if no ancestor provider
exists.

## `provideStreamDefaults`

Set shared defaults (typically `apiUrl` + `apiKey`) at the
application level so components only need to specify what's unique to
them:

```typescript
// app.config.ts
import { ApplicationConfig } from "@angular/core";
import { provideStreamDefaults } from "@langchain/angular";

export const appConfig: ApplicationConfig = {
  providers: [
    provideStreamDefaults({
      apiUrl: "http://localhost:2024",
      apiKey: environment.apiKey,
    }),
  ],
};
```

Subsequent `injectStream({ assistantId: "agent" })` calls inherit
`apiUrl` / `apiKey` automatically. Component-level `injectStream`
options still override the defaults.

## `StreamService`

`StreamService` is a thin `@Injectable()` wrapper around the
framework-agnostic `useStream` factory. Extend it when you want a
`providedIn: "root"` (or component-scoped) service that forwards the
full `StreamApi`:

```typescript
import { Injectable } from "@angular/core";
import { StreamService } from "@langchain/angular";
import type { BaseMessage } from "@langchain/core/messages";

interface ChatState {
  messages: BaseMessage[];
}

@Injectable({ providedIn: "root" })
export class ChatStream extends StreamService<ChatState> {
  constructor() {
    super({
      assistantId: "agent",
      apiUrl: "http://localhost:2024",
    });
  }
}
```

Consumers `inject(ChatStream)` and read `chat.messages()`, call
`chat.submit(…)`, etc. The service exposes the same surface as
`injectStream` — the raw `StreamApi` handle is also available as
`chat.stream` for code that needs to pass it into selector injectors.

## Multiple agents

Every `provideStream` call is scoped to the component subtree it's
declared on, so nested providers get isolated controllers:

```typescript
@Component({
  selector: "app-research-panel",
  providers: [
    provideStream({ assistantId: "researcher", apiUrl: "http://localhost:2024" }),
  ],
  template: `<app-message-list /> <app-message-input />`,
})
export class ResearchPanelComponent {}

@Component({
  selector: "app-writer-panel",
  providers: [
    provideStream({ assistantId: "writer", apiUrl: "http://localhost:2024" }),
  ],
  template: `<app-message-list /> <app-message-input />`,
})
export class WriterPanelComponent {}
```

Both `app-message-list` components call `injectStreamContext()` — each
resolves the nearest ancestor provider, so they stay wired to their
respective agents.

## Which primitive should I use?

| Use case | Primitive |
|---|---|
| Share one stream across a handful of sibling components | `provideStream` + `injectStreamContext` |
| Set app-wide `apiUrl` / `apiKey` defaults | `provideStreamDefaults` |
| Expose stream logic through a class-based service (e.g. for unit mocking, bespoke methods) | `StreamService` |

## Related

- [`injectStream`](./inject-stream.md)
- [Testing](./testing.md) — swapping a provided stream for a double
