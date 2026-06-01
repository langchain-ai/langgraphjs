import { defineComponent, onScopeDispose, ref, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  STREAM_CONTROLLER,
  useMessages,
  useStream,
  useToolCalls,
  type SubagentDiscoverySnapshot,
} from "../../index.js";

type Thread = ReturnType<typeof useStream<{ messages: BaseMessage[] }>>;

interface InitialMounts {
  rootMessages?: boolean;
  researcherMessagesA?: boolean;
  researcherMessagesB?: boolean;
  researcherToolCalls?: boolean;
  analystMessages?: boolean;
}

export const DeepAgentSubscriptionStream = defineComponent({
  name: "DeepAgentSubscriptionStream",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, default: "deepAgent" },
    initialMounts: {
      type: Object as PropType<InitialMounts>,
      default: () => ({}),
    },
  },
  setup(props) {
    const thread = useStream<{ messages: BaseMessage[] }>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const mounts = ref({
      rootMessages: props.initialMounts.rootMessages ?? false,
      researcherMessagesA: props.initialMounts.researcherMessagesA ?? false,
      researcherMessagesB: props.initialMounts.researcherMessagesB ?? false,
      researcherToolCalls: props.initialMounts.researcherToolCalls ?? false,
      analystMessages: props.initialMounts.analystMessages ?? false,
    });

    const toggle = (key: keyof InitialMounts) => {
      mounts.value = { ...mounts.value, [key]: !mounts.value[key] };
    };

    return () => {
      const subagents = [...thread.subagents.value.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const researcher = subagents.find((s) => s.name === "researcher");
      const analyst = subagents.find((s) => s.name === "data-analyst");

      return (
        <div>
          <div data-testid="loading">
            {thread.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="subagent-count">{subagents.length}</div>
          <RegistryDiagnostics stream={thread} />

          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [new HumanMessage("Run analysis")],
              })
            }
          >
            Run
          </button>

          <button
            data-testid="toggle-root-messages"
            onClick={() => toggle("rootMessages")}
          >
            Toggle root messages observer
          </button>
          <button
            data-testid="toggle-researcher-messages-a"
            onClick={() => toggle("researcherMessagesA")}
          >
            Toggle researcher messages observer A
          </button>
          <button
            data-testid="toggle-researcher-messages-b"
            onClick={() => toggle("researcherMessagesB")}
          >
            Toggle researcher messages observer B
          </button>
          <button
            data-testid="toggle-researcher-toolcalls"
            onClick={() => toggle("researcherToolCalls")}
          >
            Toggle researcher tool-calls observer
          </button>
          <button
            data-testid="toggle-analyst-messages"
            onClick={() => toggle("analystMessages")}
          >
            Toggle analyst messages observer
          </button>

          {mounts.value.rootMessages ? <RootMessagesView stream={thread} /> : null}
          {mounts.value.researcherMessagesA && researcher ? (
            <ScopedMessagesView
              id="researcher-a"
              stream={thread}
              subagent={researcher}
            />
          ) : null}
          {mounts.value.researcherMessagesB && researcher ? (
            <ScopedMessagesView
              id="researcher-b"
              stream={thread}
              subagent={researcher}
            />
          ) : null}
          {mounts.value.researcherToolCalls && researcher ? (
            <ScopedToolCallsView
              id="researcher-tc"
              stream={thread}
              subagent={researcher}
            />
          ) : null}
          {mounts.value.analystMessages && analyst ? (
            <ScopedMessagesView id="analyst" stream={thread} subagent={analyst} />
          ) : null}
        </div>
      );
    };
  },
});

const RegistryDiagnostics = defineComponent({
  name: "RegistryDiagnostics",
  props: {
    stream: { type: Object as PropType<Thread>, required: true },
  },
  setup(props) {
    const tick = ref(0);
    const handle = setInterval(() => {
      tick.value += 1;
    }, 25);
    onScopeDispose(() => clearInterval(handle));

    return () => {
      void tick.value;
      return (
        <div data-testid="registry-size">
          {props.stream[STREAM_CONTROLLER].registry.size}
        </div>
      );
    };
  },
});

const RootMessagesView = defineComponent({
  name: "RootMessagesView",
  props: {
    stream: { type: Object as PropType<Thread>, required: true },
  },
  setup(props) {
    const messages = useMessages(props.stream);
    return () => <div data-testid="root-observer-count">{messages.value.length}</div>;
  },
});

const ScopedMessagesView = defineComponent({
  name: "ScopedMessagesView",
  props: {
    stream: { type: Object as PropType<Thread>, required: true },
    subagent: {
      type: Object as PropType<SubagentDiscoverySnapshot>,
      required: true,
    },
    id: { type: String, required: true },
  },
  setup(props) {
    const messages = useMessages(props.stream, () => props.subagent);
    return () => (
      <div data-testid={`obs-${props.id}`}>
        <div data-testid={`obs-${props.id}-count`}>{messages.value.length}</div>
        <div data-testid={`obs-${props.id}-namespace`}>
          {props.subagent.namespace.join("/")}
        </div>
        <div data-testid={`obs-${props.id}-types`}>
          {messages.value.map((m) => m.getType()).join(",")}
        </div>
      </div>
    );
  },
});

const ScopedToolCallsView = defineComponent({
  name: "ScopedToolCallsView",
  props: {
    stream: { type: Object as PropType<Thread>, required: true },
    subagent: {
      type: Object as PropType<SubagentDiscoverySnapshot>,
      required: true,
    },
    id: { type: String, required: true },
  },
  setup(props) {
    const toolCalls = useToolCalls(props.stream, () => props.subagent);
    return () => (
      <div data-testid={`obs-${props.id}`}>
        <div data-testid={`obs-${props.id}-count`}>{toolCalls.value.length}</div>
        <div data-testid={`obs-${props.id}-names`}>
          {toolCalls.value.map((tc) => tc.name).join(",")}
        </div>
      </div>
    );
  },
});
