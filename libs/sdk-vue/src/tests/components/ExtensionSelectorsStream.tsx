import { defineComponent, ref, watch } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useChannel, useExtension, useStream, useValues } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

export const ExtensionSelectorsStream = defineComponent({
  name: "ExtensionSelectorsStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "customChannelAgent" },
    extensionName: { type: String, default: "status" },
    rawBufferSize: { type: Number, default: undefined },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });
    const extension = useExtension<{ label: string; params?: unknown }>(
      stream,
      props.extensionName,
    );
    const customEvents = useChannel(stream, ["custom"], undefined, {
      bufferSize: props.rawBufferSize,
    });
    const values = useValues<StreamState>(stream);
    const extensionCount = ref(0);

    watch(
      extension,
      (value) => {
        if (value == null) return;
        extensionCount.value += 1;
      },
      { flush: "sync" },
    );

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>

        <div data-testid="extension-label">{extension.value?.label ?? ""}</div>
        <div data-testid="extension-count">{extensionCount.value}</div>
        <div data-testid="extension-json">
          {extension.value == null ? "" : JSON.stringify(extension.value)}
        </div>
        <div data-testid="custom-event-count">{customEvents.value.length}</div>
        <div data-testid="custom-event-types">
          {customEvents.value.map((event) => event.method ?? "").join(",")}
        </div>

        <div data-testid="values-message-count">
          {values.value?.messages?.length ?? 0}
        </div>

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
