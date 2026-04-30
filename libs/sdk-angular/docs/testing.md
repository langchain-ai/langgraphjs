# Testing

Test hosts can either mount the component directly (Angular TestBed +
`vitest-browser-angular`), or swap the shared instance for a double:

```typescript
import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { STREAM_INSTANCE } from "@langchain/angular";

const fakeStream = {
  messages: signal([]),
  isLoading: signal(false),
  submit: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  // …plus whichever fields the component reads
};

TestBed.configureTestingModule({
  providers: [{ provide: STREAM_INSTANCE, useValue: fakeStream }],
});
```

`STREAM_INSTANCE` is the `InjectionToken` that `provideStream` binds
to and zero-argument `injectStream()` reads from — overriding it in the test
bed short-circuits any `provideStream(…)` declared on the component.

## Driving the fake from a test

Because the fake is made of `signal`s, you can push state from the
test directly:

```typescript
fakeStream.messages.set([
  { id: "1", type: "human", content: "Hello" },
  { id: "2", type: "ai",    content: "Hi there!" },
]);
await fixture.whenStable();
expect(element.textContent).toContain("Hi there!");
```

## Faking selectors

Selectors read from the `stream` argument, so they pick up the fake
as long as your component gets it via zero-argument `injectStream()`.
Selectors that accept a `target` (e.g. `injectMessages(stream,
subagent)`) still work — just make sure the fake exposes the subset
of fields the selector reads (typically `values`, `messages`,
`subagents`, and the internal event buffer).

If you only care about a few selector outputs, it's usually simpler
to stub the selectors themselves with test module providers than to
build a fully-featured fake stream.

## Services based on `StreamService`

For services based on [`StreamService`](./dependency-injection.md),
swap the service itself via the standard `providers` override:

```typescript
TestBed.configureTestingModule({
  providers: [{ provide: ChatStream, useValue: fakeChatStream }],
});
```

No need to touch `STREAM_INSTANCE` in this case — the service owns
its own controller.

## Related

- [Dependency injection](./dependency-injection.md)
- [`injectStream` return shape](./inject-stream.md#return-shape) —
  field reference for building fakes
