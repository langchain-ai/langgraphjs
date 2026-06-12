import { computed, defineComponent, ref } from "vue";
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

    const selectedIndex = ref(0);
    const selectedId = computed(() => stream.messages.value[selectedIndex.value]?.id);
    const selectedMetadata = useMessageMetadata(stream, selectedId);

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
          {selectedMetadata.value?.parentCheckpointId ?? "none"}
        </div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <div data-testid="selected-message-index">{selectedIndex.value}</div>
        <div data-testid="selected-message-content">
          {(() => {
            const msg = stream.messages.value[selectedIndex.value];
            if (!msg) return "";
            return typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          })()}
        </div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ messages: [new HumanMessage("Hello")] })
          }
        >
          Send
        </button>
        <button
          data-testid="select-message-1"
          onClick={() => {
            selectedIndex.value = 1;
          }}
        >
          Select message 1
        </button>
      </div>
    );
  },
});
