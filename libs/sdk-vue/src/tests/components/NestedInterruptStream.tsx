import { computed, defineComponent, type PropType } from "vue";

import { useStream } from "../../index.js";

interface NestedInterruptState {
  request?: string;
  decision?: Record<string, unknown> | null;
  completed?: boolean;
  messages?: unknown[];
}

/**
 * HITL harness for nested / subagent interrupts.
 *
 * Exposes namespace and resumes via `respond({ interruptId })` without
 * an explicit `namespace` so the controller lookup path is covered.
 */
export const NestedInterruptStream = defineComponent({
  name: "NestedInterruptStream",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    threadId: { type: String, default: undefined },
    onThreadId: {
      type: Function as unknown as () => (threadId: string) => void,
      default: undefined,
    },
    submitInput: {
      type: Object as PropType<Record<string, unknown>>,
      required: true,
    },
  },
  setup(props) {
    const stream = useStream<NestedInterruptState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId: props.threadId,
      onThreadId: props.onThreadId,
    });

    const interruptPrompt = computed(() => {
      const promptValue = stream.interrupt.value?.value;
      if (
        promptValue != null &&
        typeof promptValue === "object" &&
        "prompt" in (promptValue as object)
      ) {
        return String((promptValue as { prompt?: unknown }).prompt ?? "");
      }
      return "";
    });

    const namespaceJson = computed(() =>
      JSON.stringify(stream.interrupt.value?.namespace ?? [])
    );

    return () => (
      <div>
        <div data-testid="interrupt-count">
          {stream.interrupts.value.length}
        </div>
        <div data-testid="interrupt-prompt">{interruptPrompt.value}</div>
        <div data-testid="interrupt-id">
          {stream.interrupt.value?.id ?? ""}
        </div>
        <div data-testid="interrupt-namespace">{namespaceJson.value}</div>
        <div data-testid="completed">
          {stream.values.value?.completed ? "true" : "false"}
        </div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <button
          data-testid="submit"
          onClick={() => void stream.submit(props.submitInput)}
        >
          Submit
        </button>
        <button
          data-testid="resume"
          onClick={() => {
            const id = stream.interrupt.value?.id;
            if (id != null) {
              void stream.respond({ approved: true }, { interruptId: id });
            }
          }}
        >
          Resume
        </button>
      </div>
    );
  },
});
