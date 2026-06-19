import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

export const ReattachStream = defineComponent({
  name: "ReattachStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "slowAgent" },
  },
  setup(props) {
    const threadId = ref<string | undefined>(undefined);
    const secondaryMounted = ref(false);

    const primary = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId,
      onThreadId: (id) => {
        threadId.value = id;
      },
    });

    return () => (
      <div>
        <div data-testid="primary-loading">
          {primary.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="primary-thread-id">
          {primary.threadId.value ?? "none"}
        </div>
        <div data-testid="primary-message-count">
          {primary.messages.value.length}
        </div>
        <button
          data-testid="primary-submit"
          onClick={() =>
            void primary.submit({ messages: [new HumanMessage("Hello")] })
          }
        >
          Start slow run
        </button>
        <button
          data-testid="secondary-mount"
          disabled={threadId.value == null}
          onClick={() => {
            secondaryMounted.value = true;
          }}
        >
          Mount secondary
        </button>
        <button
          data-testid="secondary-unmount"
          onClick={() => {
            secondaryMounted.value = false;
          }}
        >
          Unmount secondary
        </button>
        {secondaryMounted.value && threadId.value != null ? (
          <SecondaryStream
            apiUrl={props.apiUrl}
            assistantId={props.assistantId}
            threadId={threadId.value}
          />
        ) : (
          <div data-testid="secondary-mounted">no</div>
        )}
      </div>
    );
  },
});

const SecondaryStream = defineComponent({
  name: "SecondaryStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, required: true },
    threadId: { type: String, required: true },
  },
  setup(props) {
    const secondary = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId: props.threadId,
    });

    return () => (
      <div>
        <div data-testid="secondary-mounted">yes</div>
        <div data-testid="secondary-loading">
          {secondary.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="secondary-thread-id">
          {secondary.threadId.value ?? "none"}
        </div>
        <div data-testid="secondary-message-count">
          {secondary.messages.value.length}
        </div>
      </div>
    );
  },
});
