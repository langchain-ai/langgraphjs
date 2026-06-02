import { defineComponent, type PropType } from "vue";

import {
  useToolCalls,
  type SubagentDiscoverySnapshot,
} from "../../index.js";

export const DeepAgentResearcherSummary = defineComponent({
  name: "DeepAgentResearcherSummary",
  props: {
    stream: { type: Object as PropType<any>, required: true },
    subagent: {
      type: Object as PropType<SubagentDiscoverySnapshot>,
      required: true,
    },
  },
  setup(props) {
    const toolCalls = useToolCalls(props.stream, () => props.subagent);

    return () => {
      const latestToolCall = toolCalls.value.at(-1);
      const input =
        typeof latestToolCall?.input === "string"
          ? latestToolCall.input
          : JSON.stringify(latestToolCall?.input ?? {});
      return (
        <>
          <div data-testid="retained-subagent-summary-tool">
            {latestToolCall?.name || "missing"}
          </div>
          <div data-testid="retained-subagent-summary-args">
            {input}
          </div>
        </>
      );
    };
  },
});
