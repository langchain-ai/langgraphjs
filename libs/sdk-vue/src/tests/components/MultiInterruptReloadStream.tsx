import { defineComponent, onBeforeUnmount, ref, type PropType } from "vue";

import { useStream } from "../../index.js";

interface MultiInterruptState {
  prompts: string[];
  decisions: Record<string, unknown>;
  completed: boolean;
}

/** Milliseconds the session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

const MultiInterruptReloadSession = defineComponent({
  name: "MultiInterruptReloadSession",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    threadId: { type: String, default: undefined },
    onThreadId: {
      type: Function as PropType<(threadId: string) => void>,
      required: true,
    },
  },
  setup(props) {
    const thread = useStream<MultiInterruptState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId: () => props.threadId,
      onThreadId: props.onThreadId,
    });
    const actionError = ref("");
    const record = (error: unknown) => {
      actionError.value = error instanceof Error ? error.message : String(error);
    };

    return () => (
      <div>
        <div data-testid="interrupt-count">{thread.interrupts.value.length}</div>
        <div data-testid="completed">
          {thread.values.value?.completed ? "true" : "false"}
        </div>
        <div data-testid="loading">
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="thread-loading">
          {thread.isThreadLoading.value ? "Hydrating..." : "Ready"}
        </div>
        <div data-testid="error">
          {thread.error.value ? String(thread.error.value) : ""}
        </div>
        <div data-testid="action-error">{actionError.value}</div>
        <button
          data-testid="submit"
          onClick={() => {
            actionError.value = "";
            void thread.submit({ prompts: ["A", "B"] }).catch(record);
          }}
        >
          Submit
        </button>
        <button
          data-testid="free-text-submit"
          onClick={() => {
            actionError.value = "";
            void thread.submit({ prompts: ["follow-up"] }).catch(record);
          }}
        >
          Free-text submit
        </button>
        <button
          data-testid="resume-all"
          onClick={() => {
            actionError.value = "";
            void thread
              .respondAll(
                Object.fromEntries(
                  thread.interrupts.value.flatMap((entry) =>
                    entry.id == null ? [] : [[entry.id, { approved: true }]]
                  )
                )
              )
              .catch(record);
          }}
        >
          Resume all
        </button>
      </div>
    );
  },
});

/**
 * Parallel-interrupt harness whose `reload` button remounts `useStream` on
 * the same thread, like a page refresh, so a test can check what the server
 * kept rather than what the client still shows.
 */
export const MultiInterruptReloadStream = defineComponent({
  name: "MultiInterruptReloadStream",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, default: "multi_interrupt_graph" },
  },
  setup(props) {
    const threadId = ref<string>();
    const session = ref(0);
    const mounted = ref(true);
    let reloadTimer: number | undefined;

    onBeforeUnmount(() => window.clearTimeout(reloadTimer));

    const reload = () => {
      mounted.value = false;
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        session.value += 1;
        mounted.value = true;
      }, RELOAD_GAP_MS);
    };

    return () => (
      <div>
        <div data-testid="session">{session.value}</div>
        <button data-testid="reload" onClick={reload}>
          Reload
        </button>
        {mounted.value ? (
          <MultiInterruptReloadSession
            key={session.value}
            apiUrl={props.apiUrl}
            assistantId={props.assistantId}
            threadId={threadId.value}
            onThreadId={(id: string) => {
              threadId.value = id;
            }}
          />
        ) : null}
      </div>
    );
  },
});
