import { defineComponent, type PropType } from "vue";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

export const InitialValuesStream = defineComponent({
  name: "InitialValuesStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
    initialValues: {
      type: Object as PropType<StreamState>,
      required: true,
    },
  },
  setup(props) {
    const thread = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      initialValues: props.initialValues,
    });

    return () => (
      <div>
        <div data-testid="messages">
          {thread.messages.value.map((msg, i) => (
            <div key={msg.id ?? `cached-${i}`} data-testid={`message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>
        <div data-testid="values">
          {thread.values.value?.messages
            ?.map((m) =>
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
            )
            .join("|") ?? ""}
        </div>
        <div data-testid="loading">
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <button
          data-testid="submit"
          onClick={() =>
            void thread.submit({
              messages: [new HumanMessage("Fresh request")],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});

export const initialAICached = (id: string, content: string) =>
  new AIMessage({ id, content });

export const initialHumanCached = (id: string, content: string) =>
  new HumanMessage({ id, content });
