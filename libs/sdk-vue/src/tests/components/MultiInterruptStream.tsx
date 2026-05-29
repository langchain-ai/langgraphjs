import { computed, defineComponent, ref, watch } from "vue";

import { useStream } from "../../index.js";

interface MultiInterruptState {
  prompts: string[];
  decisions: Record<string, unknown>;
  completed: boolean;
}

export const MultiInterruptStream = defineComponent({
  name: "MultiInterruptStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "multi_interrupt_graph" },
  },
  setup(props) {
    const stream = useStream<MultiInterruptState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const threadInterruptCount = ref(0);
    watch(
      [
        () => stream.isLoading.value,
        () => stream.interrupts.value,
        () => stream.values.value,
      ],
      () => {
        threadInterruptCount.value = stream.getThread()?.interrupts.length ?? 0;
      },
      { immediate: true }
    );

    const pendingInterruptCount = computed(() => threadInterruptCount.value);

    const decisionsJson = computed(() =>
      JSON.stringify(stream.values.value?.decisions ?? {})
    );

    return () => (
      <div>
        <div data-testid="interrupt-count">
          {stream.interrupts.value.length}
        </div>
        <div data-testid="thread-interrupt-count">
          {pendingInterruptCount.value}
        </div>
        <div data-testid="completed">
          {stream.values.value?.completed ? "true" : "false"}
        </div>
        <div data-testid="decisions">{decisionsJson.value}</div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ prompts: ["A", "B"] })
          }
        >
          Submit
        </button>
        <button
          data-testid="resume-all"
          onClick={() => {
            const interrupts = stream.getThread()?.interrupts ?? [];
            if (interrupts.length === 0) return;
            void stream.respondAll(
              Object.fromEntries(
                interrupts.map((entry) => {
                  const action =
                    entry.payload != null &&
                    typeof entry.payload === "object" &&
                    "action" in entry.payload
                      ? String((entry.payload as { action?: unknown }).action)
                      : "";
                  return [
                    entry.interruptId,
                    action === "A"
                      ? { approved: true }
                      : { approved: false },
                  ];
                })
              )
            );
          }}
        >
          Resume all
        </button>
      </div>
    );
  },
});
