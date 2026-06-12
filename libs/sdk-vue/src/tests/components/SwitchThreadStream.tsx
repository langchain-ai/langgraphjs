import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Mounts `useStream` with a reactive `threadId` ref and exposes buttons
 * to change that id (or reset to `null`). Used to verify that
 * `hydrate()` rebinds the underlying thread and clears the rendered
 * snapshot.
 */
export const SwitchThreadStream = defineComponent({
  name: "SwitchThreadStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
  },
  setup(props) {
    const threadId = ref<string | null>(null);
    const observedThreadLoading = ref(false);

    const thread = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId,
      onThreadId: (id) => {
        threadId.value = id;
      },
    });

    return () => {
      if (thread.isThreadLoading.value) observedThreadLoading.value = true;
      return (
        <div>
        <div data-testid="message-count">{thread.messages.value.length}</div>
        <div data-testid="thread-id">{thread.threadId.value ?? "none"}</div>
        <div data-testid="loading">
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="thread-loading">
          {thread.isThreadLoading.value ? "Hydrating..." : "Ready"}
        </div>
        <div data-testid="observed-thread-loading">
          {observedThreadLoading.value ? "yes" : "no"}
        </div>
        <div data-testid="messages">
          {thread.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>

        <button
          data-testid="submit"
          onClick={() =>
            void thread.submit({
              messages: [new HumanMessage("Hello")],
            })
          }
        >
          Send
        </button>
        <button
          data-testid="switch-thread"
          onClick={() => {
            threadId.value = crypto.randomUUID();
          }}
        >
          Switch Thread
        </button>
        <button
          data-testid="switch-thread-null"
          onClick={() => {
            threadId.value = null;
          }}
        >
          Clear Thread
        </button>
        </div>
      );
    };
  },
});
