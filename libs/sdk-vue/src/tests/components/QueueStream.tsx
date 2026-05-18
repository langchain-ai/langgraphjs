import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useSubmissionQueue } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

export const QueueStream = defineComponent({
  name: "QueueStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "slowAgent" },
  },
  setup(props) {
    const threadId = ref<string | null>(null);

    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId,
      onThreadId: (id) => {
        threadId.value = id;
      },
    });

    const queue = useSubmissionQueue(stream);

    const enqueue = (content: string) => {
      void stream.submit(
        { messages: [new HumanMessage(content)] },
        { multitaskStrategy: "enqueue" },
      );
    };

    const entriesText = () =>
      queue.entries.value
        .map((entry) => {
          const messages = (entry.values as StreamState | undefined)?.messages;
          const first = Array.isArray(messages) ? messages[0] : undefined;
          return first ? formatMessage(first) : "?";
        })
        .join(",");

    const cancelFirst = () => {
      const first = queue.entries.value[0];
      if (first) void queue.cancel(first.id);
    };

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>

        <div data-testid="queue-size">{queue.size.value}</div>
        <div data-testid="queue-entries">{entriesText()}</div>

        <button data-testid="submit-first" onClick={() => enqueue("Msg1")}>
          Submit First
        </button>
        <button
          data-testid="submit-three"
          onClick={() => {
            enqueue("Msg2");
            enqueue("Msg3");
            enqueue("Msg4");
          }}
        >
          Submit Three
        </button>
        <button data-testid="cancel-first" onClick={cancelFirst}>
          Cancel First
        </button>
        <button data-testid="clear-queue" onClick={() => void queue.clear()}>
          Clear Queue
        </button>
        <button
          data-testid="switch-thread"
          onClick={() => {
            threadId.value = crypto.randomUUID();
          }}
        >
          Switch Thread
        </button>
      </div>
    );
  },
});
