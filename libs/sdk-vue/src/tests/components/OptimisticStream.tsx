import { defineComponent, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useMessageMetadata } from "../../index.js";
import type { UseStreamReturn } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
}

const MessageRow = defineComponent({
  name: "MessageRow",
  props: {
    stream: {
      type: Object as PropType<UseStreamReturn<StreamState>>,
      required: true,
    },
    index: { type: Number, required: true },
    message: { type: Object as PropType<BaseMessage>, required: true },
  },
  setup(props) {
    const metadata = useMessageMetadata(props.stream, () => props.message.id);
    // Latch: the server echoes the input message id almost immediately, so
    // the live `pending` status is a sub-frame transient that a polling
    // assertion can race under suite load. Recording that we *ever*
    // rendered `pending` is sticky and race-free.
    let everPending = false;
    return () => {
      const status = metadata.value?.optimisticStatus ?? "none";
      if (status === "pending") everPending = true;
      return (
        <div data-testid={`message-${props.index}`}>
          <span data-testid={`message-${props.index}-content`}>
            {formatMessage(props.message)}
          </span>
          <span data-testid={`message-${props.index}-status`}>{status}</span>
          <span data-testid={`message-${props.index}-ever-pending`}>
            {everPending ? "true" : "false"}
          </span>
        </div>
      );
    };
  },
});

export const OptimisticStream = defineComponent({
  name: "OptimisticStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
    optimistic: { type: Boolean as PropType<boolean>, default: undefined },
    submitText: { type: String, default: "Hello" },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      optimistic: props.optimistic,
    });

    return () => (
      <div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <MessageRow
              key={msg.id ?? i}
              stream={stream}
              index={i}
              message={msg}
            />
          ))}
        </div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        {stream.error.value ? (
          <div data-testid="error">{String(stream.error.value)}</div>
        ) : null}
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({
              messages: [new HumanMessage(props.submitText)],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});
