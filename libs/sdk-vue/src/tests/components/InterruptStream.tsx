import { computed, defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface InterruptState {
  messages: BaseMessage[];
}

export const InterruptStream = defineComponent({
  name: "InterruptStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "interruptAgent" },
    /** When true, the Resume button uses stream.respond() directly. */
    useRespondMethod: { type: Boolean, default: false },
  },
  setup(props) {
    const stream = useStream<InterruptState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const interruptNode = computed(() => {
      const value = stream.interrupt.value?.value as
        | { nodeName?: string }
        | undefined;
      return value?.nodeName ?? "";
    });

    const lastMessage = computed(() => {
      const msgs = stream.messages.value;
      if (msgs.length === 0) return "";
      return formatMessage(msgs[msgs.length - 1]);
    });

    return () => (
      <div>
        <div data-testid="interrupt-count">
          {stream.interrupts.value.length}
        </div>
        <div data-testid="interrupt-id">
          {stream.interrupt.value?.id ?? ""}
        </div>
        <div data-testid="interrupt-node">{interruptNode.value}</div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="last-message">{lastMessage.value}</div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {formatMessage(msg)}
            </div>
          ))}
        </div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ messages: [new HumanMessage("ship it")] })
          }
        >
          Submit
        </button>
        <button
          data-testid="resume"
          onClick={() => {
            if (props.useRespondMethod && stream.interrupt.value) {
              void stream.respond("approved");
            } else {
              void stream.submit(undefined, {
                command: { resume: "approved" },
              });
            }
          }}
        >
          Resume
        </button>
      </div>
    );
  },
});
