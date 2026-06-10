import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useChannelEffect, useStream, type Channel } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Exercises {@link useChannelEffect}: each raw event observed on the
 * requested channels is pushed into component state so the test can
 * assert on the delivered count / order.
 */
export const ChannelEffectStream = defineComponent({
  name: "ChannelEffectStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "customChannelAgent" },
    channels: {
      type: Array as () => Channel[],
      default: () => ["custom"] as Channel[],
    },
    enabled: { type: Boolean, default: true },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });
    const count = ref(0);
    const methods = ref<string[]>([]);

    useChannelEffect(stream, () => props.channels, {
      enabled: () => props.enabled,
      replay: false,
      onEvent(event) {
        count.value += 1;
        methods.value = [...methods.value, event.method ?? ""];
      },
    });

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="effect-count">{count.value}</div>
        <div data-testid="effect-methods">{methods.value.join(",")}</div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({
              messages: [new HumanMessage("Trigger custom writer")],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});
