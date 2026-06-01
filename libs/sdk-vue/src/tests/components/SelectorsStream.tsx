import { computed, defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  useStream,
  useMessages,
  useToolCalls,
  useValues,
} from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

export const SelectorsStream = defineComponent({
  name: "SelectorsStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "agent" },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const messages = useMessages(stream);
    const toolCalls = useToolCalls(stream);
    const values = useValues(stream);

    const valuesString = computed(() => {
      try {
        return JSON.stringify(values.value);
      } catch {
        return "{}";
      }
    });

    return () => (
      <div>
        <div data-testid="messages-count">{messages.value.length}</div>
        <div data-testid="toolcalls-count">{toolCalls.value.length}</div>
        <div data-testid="values-json">{valuesString.value}</div>
        {messages.value.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`selector-message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
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
