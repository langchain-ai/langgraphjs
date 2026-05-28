import { defineComponent, type PropType } from "vue";

import {
  useMessages,
  useToolCalls,
  type SubagentDiscoverySnapshot,
} from "../../index.js";

export const DeepAgentSubagentCard = defineComponent({
  name: "DeepAgentSubagentCard",
  props: {
    stream: { type: Object as PropType<any>, required: true },
    subagent: {
      type: Object as PropType<SubagentDiscoverySnapshot>,
      required: true,
    },
  },
  setup(props) {
    const messages = useMessages(props.stream, () => props.subagent);
    const toolCalls = useToolCalls(props.stream, () => props.subagent);

    return () => {
      const sub = props.subagent;
      const subType = sub.name ?? "unknown";

      return (
        <div
          key={sub.id}
          data-testid={`subagent-${subType}`}
          style={{
            margin: "8px 0",
            paddingLeft: "12px",
            borderLeft: "2px solid #999",
          }}
        >
          <div data-testid={`subagent-${subType}-status`}>
            SubAgent ({subType}) status: {sub.status}
          </div>
          <div data-testid={`subagent-${subType}-messages-count`}>
            {messages.value.length}
          </div>
          <div data-testid={`subagent-${subType}-toolcalls-count`}>
            {toolCalls.value.length}
          </div>
          <div data-testid={`subagent-${subType}-toolcall-names`}>
            {toolCalls.value.map((tc) => tc.name).join(",")}
          </div>
        </div>
      );
    };
  },
});
