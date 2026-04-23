import { defineComponent, type PropType } from "vue";
import { HumanMessage } from "@langchain/core/messages";

import { provideStream, useStreamContext, useMessages } from "../../index.js";
import { formatMessage } from "./format.js";

const Child = defineComponent({
  name: "ContextChild",
  setup() {
    const thread = useStreamContext();
    const messages = useMessages(thread);

    return () => (
      <div>
        <div data-testid="child-count">{messages.value.length}</div>
        <div data-testid="child-messages">
          {messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`child-message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>
        <button
          data-testid="child-submit"
          onClick={() =>
            void thread.submit({
              messages: [new HumanMessage("Hello")],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});

export const ContextStream = defineComponent({
  name: "ContextStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String as PropType<string>, default: "agent" },
  },
  setup(props) {
    provideStream({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    return () => <Child />;
  },
});
