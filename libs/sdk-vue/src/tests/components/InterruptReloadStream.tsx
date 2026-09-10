import {
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  type PropType,
} from "vue";

import { useStream } from "../../index.js";
import { createDurableReplayFetch } from "../fixtures/durable-replay-fetch.js";

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completedTurns: number;
}

const InterruptReloadSession = defineComponent({
  props: {
    apiUrl: { type: String, required: true },
    threadId: { type: String, default: undefined },
    onThreadId: {
      type: Function as PropType<(threadId: string) => void>,
      required: true,
    },
    fetch: {
      type: Function as PropType<typeof globalThis.fetch>,
      required: true,
    },
  },
  setup(props) {
    const stream = useStream<InterruptState>({
      assistantId: "interrupt_once_graph",
      apiUrl: props.apiUrl,
      threadId: props.threadId,
      onThreadId: props.onThreadId,
      fetch: props.fetch,
    });

    return () => (
      <div>
        <div data-testid="interrupt-count">{stream.interrupts.value.length}</div>
        <div data-testid="interrupt-ids">
          {stream.interrupts.value.map((item) => item.id ?? "?").join(",")}
        </div>
        <div data-testid="completed-turns">
          {stream.values.value?.completedTurns ?? 0}
        </div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="thread-loading">
          {stream.isThreadLoading.value ? "Hydrating..." : "Ready"}
        </div>
        <button
          data-testid="submit"
          onClick={() => void stream.submit({ request: "ship it" })}
        >
          Submit
        </button>
        <button
          data-testid="resume"
          onClick={() => {
            if (stream.interrupt.value) {
              void stream.respond({ approved: true });
            }
          }}
        >
          Resume
        </button>
      </div>
    );
  },
});

export const InterruptReloadStream = defineComponent({
  props: {
    apiUrl: { type: String, required: true },
  },
  setup(props) {
    const durable = createDurableReplayFetch();
    const threadId = ref<string>();
    const session = ref(0);
    const mounted = ref(true);
    const replayedFrames = ref(0);
    let reloadTimer: number | undefined;
    let replayTimer: number | undefined;

    onMounted(() => {
      replayTimer = window.setInterval(() => {
        replayedFrames.value = durable.replayedFrameCount();
      }, 50);
    });
    onBeforeUnmount(() => {
      window.clearTimeout(reloadTimer);
      window.clearInterval(replayTimer);
    });

    const reload = () => {
      mounted.value = false;
      reloadTimer = window.setTimeout(() => {
        session.value += 1;
        mounted.value = true;
      }, 100);
    };

    return () => (
      <div>
        <div data-testid="session">{session.value}</div>
        <div data-testid="replayed-frames">{replayedFrames.value}</div>
        <button data-testid="reload" onClick={reload}>
          Reload
        </button>
        {mounted.value ? (
          <InterruptReloadSession
            key={session.value}
            apiUrl={props.apiUrl}
            threadId={threadId.value}
            onThreadId={(id) => {
              threadId.value = id;
            }}
            fetch={durable.fetch}
          />
        ) : null}
      </div>
    );
  },
});
