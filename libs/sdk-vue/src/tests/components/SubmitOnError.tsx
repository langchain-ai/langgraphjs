import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

export const SubmitOnError = defineComponent({
  name: "SubmitOnError",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "errorAgent" },
  },
  setup(props) {
    const submitError = ref<string | null>(null);

    const thread = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    return () => (
      <div>
        <div data-testid="loading">
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        {thread.error.value ? (
          <div data-testid="error">{String(thread.error.value)}</div>
        ) : null}
        {submitError.value ? (
          <div data-testid="submit-error">{submitError.value}</div>
        ) : null}
        <button
          data-testid="submit"
          onClick={() =>
            void thread.submit(
              { messages: [new HumanMessage("Hello")] },
              {
                onError: (error: unknown) => {
                  submitError.value =
                    // eslint-disable-next-line no-instanceof/no-instanceof
                    error instanceof Error ? error.message : String(error);
                },
              },
            )
          }
        >
          Send
        </button>
      </div>
    );
  },
});
