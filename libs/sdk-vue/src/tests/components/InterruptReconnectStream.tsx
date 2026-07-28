import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { createDroppableAuthFetch } from "../fixtures/droppable-auth-fetch.js";
import { formatMessage } from "./format.js";

interface InterruptState {
  messages: BaseMessage[];
}

export const InterruptReconnectStream = defineComponent({
  name: "InterruptReconnectStream",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, default: "interruptAgent" },
  },
  setup(props) {
    const droppable = createDroppableAuthFetch();
    const reconnectCount = ref(0);
    const eventOpens = ref(0);
    let timer: number | undefined;

    onMounted(() => {
      timer = window.setInterval(() => {
        eventOpens.value = droppable.eventStreamOpenCount();
      }, 50);
    });
    onUnmounted(() => {
      if (timer != null) window.clearInterval(timer);
    });

    const stream = useStream<InterruptState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      fetch: droppable.fetch,
      maxReconnectAttempts: 5,
      reconnectDelayMs: () => 0,
      streamIdleReconnect: 0,
      onReconnect: () => {
        reconnectCount.value += 1;
        eventOpens.value = droppable.eventStreamOpenCount();
      },
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
        <div data-testid="reconnect-count">{reconnectCount.value}</div>
        <div data-testid="event-stream-opens">{eventOpens.value}</div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ messages: [new HumanMessage("ship it")] })
          }
        >
          Submit
        </button>
        <button
          data-testid="drop-events"
          onClick={() => {
            droppable.dropActiveStreams();
            eventOpens.value = droppable.eventStreamOpenCount();
          }}
        >
          Drop events
        </button>
        <button
          data-testid="resume"
          onClick={() => {
            if (stream.interrupt.value) {
              void stream.respond("approved");
            }
          }}
        >
          Resume
        </button>
      </div>
    );
  },
});
