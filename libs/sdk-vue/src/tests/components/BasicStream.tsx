import { defineComponent, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StreamSubmitOptions } from "@langchain/langgraph-sdk/stream";
import type { Client } from "@langchain/langgraph-sdk";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

export const BasicStream = defineComponent({
  name: "BasicStream",
  props: {
    apiUrl: { type: String, default: undefined },
    client: { type: Object as PropType<Client>, default: undefined },
    assistantId: { type: String, default: "agent" },
    threadId: { type: String, default: undefined },
    submitInput: {
      type: Object as PropType<StreamState>,
      default: undefined,
    },
    submitOptions: {
      type: Object as PropType<StreamSubmitOptions<StreamState>>,
      default: undefined,
    },
    transport: {
      type: String as PropType<"sse" | "websocket">,
      default: undefined,
    },
    onThreadId: {
      type: Function as PropType<(threadId: string) => void>,
      default: undefined,
    },
    onCreated: {
      type: Function as PropType<
        (meta: { run_id: string; thread_id: string }) => void
      >,
      default: undefined,
    },
  },
  setup(props) {
    const thread = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      client: props.client,
      threadId: props.threadId,
      transport: props.transport,
      onThreadId: props.onThreadId,
      onCreated: props.onCreated,
    });

    return () => (
      <div>
        <div data-testid="message-count">{thread.messages.value.length}</div>
        <div data-testid="messages">
          {thread.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>
        <div data-testid="loading">
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="thread-id">{thread.threadId.value ?? "none"}</div>
        {thread.error.value ? (
          <div data-testid="error">{String(thread.error.value)}</div>
        ) : null}
        <button
          data-testid="submit"
          onClick={() =>
            void thread.submit(
              props.submitInput ?? {
                messages: [new HumanMessage("Hello")],
              },
              props.submitOptions,
            )
          }
        >
          Send
        </button>
        <button data-testid="stop" onClick={() => void thread.stop()}>
          Stop
        </button>
      </div>
    );
  },
});
