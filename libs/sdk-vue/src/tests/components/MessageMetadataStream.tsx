import { computed, defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useMessageMetadata } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Smoke test for `useMessageMetadata`: waits for the first message to
 * land and reports its recorded `parentCheckpointId`.
 */
export const MessageMetadataStream = defineComponent({
  name: "MessageMetadataStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const firstId = computed(() => stream.messages.value[0]?.id);
    const firstMetadata = useMessageMetadata(stream, firstId);

    const firstContent = computed(() => {
      const msg = stream.messages.value[0];
      if (!msg) return "";
      return typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    });

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="message-0-content">{firstContent.value}</div>
        <div data-testid="message-0-parent">
          {firstMetadata.value?.parentCheckpointId ?? "none"}
        </div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ messages: [new HumanMessage("Hello")] })
          }
        >
          Send
        </button>
      </div>
    );
  },
});
