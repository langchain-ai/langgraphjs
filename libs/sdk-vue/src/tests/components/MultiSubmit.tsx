import { defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StreamSubmitOptions } from "@langchain/langgraph-sdk/stream";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

/**
 * Module-level slot so tests can configure per-submit options (e.g.
 * `multitaskStrategy: "enqueue"`) before mounting the component.
 */
let pendingSubmitOptions: StreamSubmitOptions<StreamState> | undefined;
export function setMultiSubmitOptions(
  options: StreamSubmitOptions<StreamState> | undefined,
): void {
  pendingSubmitOptions = options;
}

export const MultiSubmit = defineComponent({
  name: "MultiSubmit",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const submitFirst = () => {
      void stream.submit(
        { messages: [new HumanMessage("Hello (1)")] },
        pendingSubmitOptions,
      );
    };

    const submitSecond = () => {
      void stream.submit(
        { messages: [new HumanMessage("Hello (2)")] },
        pendingSubmitOptions,
      );
    };

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              <span>{formatMessage(msg)}</span>
            </div>
          ))}
        </div>
        <button data-testid="submit-first" onClick={submitFirst}>
          Send First
        </button>
        <button data-testid="submit-second" onClick={submitSecond}>
          Send Second
        </button>
      </div>
    );
  },
});
