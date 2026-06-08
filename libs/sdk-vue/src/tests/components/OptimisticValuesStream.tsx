import { computed, defineComponent, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
  status?: string;
}

export const OptimisticValuesStream = defineComponent({
  name: "OptimisticValuesStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "stateful_values_graph" },
    optimistic: { type: Boolean as PropType<boolean>, default: undefined },
    submitStatus: { type: String, default: "draft" },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      optimistic: props.optimistic,
    });

    const status = computed(
      () => (stream.values.value as StreamState).status ?? "none",
    );

    return () => (
      <div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
            </div>
          ))}
        </div>
        <div data-testid="status">{status.value}</div>
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
              messages: [new HumanMessage("Hello")],
              status: props.submitStatus,
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});
