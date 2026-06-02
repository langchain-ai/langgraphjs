import { defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

export const SubmitThreadIdOverride = defineComponent({
  name: "SubmitThreadIdOverride",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
    submitThreadId: { type: String, required: true },
  },
  setup(props) {
    const stream = useStream<{ messages: BaseMessage[] }>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="thread-id">{stream.threadId.value ?? "none"}</div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit(
              { messages: [new HumanMessage("Hello")] },
              { threadId: props.submitThreadId },
            )
          }
        >
          Send
        </button>
      </div>
    );
  },
});
