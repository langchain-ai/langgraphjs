# Testing

Test hosts can mount the component directly against a running mock
server (we ship our suite with `vitest-browser-vue`), or swap the
shared stream instance for a double via `provide`:

```typescript
import { mount } from "@vue/test-utils";
import { shallowRef } from "vue";
import ChatComponent from "./ChatComponent.vue";

const fakeStream = {
  messages: shallowRef([]),
  isLoading: shallowRef(false),
  submit: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  // …plus whichever fields the component reads
};

mount(ChatComponent, {
  global: {
    provide: { "langchain-stream": fakeStream },
  },
});
```

## Testing via `provideStream`

For applications that wire `provideStream()` at the container level,
mount the container itself and let the child components pick up the
real stream through `useStreamContext()`:

```ts
import { mount } from "@vue/test-utils";
import ChatContainer from "./ChatContainer.vue";

const wrapper = mount(ChatContainer, {
  props: {
    apiUrl: "http://localhost:8123",
    assistantId: "test-agent",
  },
});
```

Any `useStreamContext()` call inside the subtree resolves to the
single instance that `ChatContainer` provides — no injection stub
required.

## Tips

- Stub only the fields your component actually reads. The selector
  composables (`useMessages`, `useSubmissionQueue`, …) all read from
  the handle's refs, so a minimal `{ messages: shallowRef([...]) }`
  is enough for a message-list snapshot test.
- For end-to-end streaming behaviour, point `apiUrl` at a dev server
  or a local `MockAgent` instead of stubbing the controller — the
  transport layer is designed to be exercised by real HTTP fixtures.
