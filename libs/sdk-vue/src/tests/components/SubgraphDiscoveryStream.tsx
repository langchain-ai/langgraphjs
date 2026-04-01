import { defineComponent, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  useMessages,
  useStream,
  type SubgraphDiscoverySnapshot,
} from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
}

export const SubgraphDiscoveryStream = defineComponent({
  name: "SubgraphDiscoveryStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "parentAgent" },
    transport: {
      type: String as PropType<"sse" | "websocket">,
      default: undefined,
    },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      transport: props.transport,
    });

    return () => {
      const subgraphs = [...stream.subgraphs.value.values()];
      const subgraphsByNodeEntries = [
        ...stream.subgraphsByNode.value.entries(),
      ].sort(([a], [b]) => a.localeCompare(b));

      return (
        <div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="root-message-count">
            {stream.messages.value.length}
          </div>
          <div data-testid="subgraph-count">{subgraphs.length}</div>
          <div data-testid="subgraph-nodes">
            {subgraphsByNodeEntries
              .map(([node, arr]) => `${node}:${arr.length}`)
              .join(",")}
          </div>

          {subgraphs.map((subgraph, i) => (
            <SubgraphPanel key={subgraph.id ?? i} stream={stream} subgraph={subgraph} />
          ))}

          <button
            data-testid="submit"
            onClick={() =>
              void stream.submit({
                messages: [new HumanMessage("Call subgraph please")],
              })
            }
          >
            Send
          </button>
        </div>
      );
    };
  },
});

const SubgraphPanel = defineComponent({
  name: "SubgraphPanel",
  props: {
    stream: { type: Object as PropType<any>, required: true },
    subgraph: {
      type: Object as PropType<SubgraphDiscoverySnapshot>,
      required: true,
    },
  },
  setup(props) {
    const messages = useMessages(props.stream, props.subgraph);

    return () => {
      const namespaceKey = props.subgraph.namespace.join("/") || "root";

      return (
        <div data-testid={`subgraph-${namespaceKey}`}>
          <div data-testid={`subgraph-${namespaceKey}-namespace`}>
            {namespaceKey}
          </div>
          <div data-testid={`subgraph-${namespaceKey}-messages-count`}>
            {messages.value.length}
          </div>
          <div data-testid={`subgraph-${namespaceKey}-messages`}>
            {messages.value.map((msg, i) => (
              <span
                key={msg.id ?? i}
                data-testid={`subgraph-${namespaceKey}-message-${i}`}
              >
                {formatMessage(msg)}
              </span>
            ))}
          </div>
        </div>
      );
    };
  },
});
