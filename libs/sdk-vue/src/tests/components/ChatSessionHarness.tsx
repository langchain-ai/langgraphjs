import {
  computed,
  defineComponent,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from "vue";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { useStream } from "../../index.js";
import {
  createDurableReplayFetch,
  type DurableReplayFetchOptions,
} from "../fixtures/durable-replay-fetch.js";
import { formatMessage } from "./format.js";

/**
 * {@link formatMessage}, with text content blocks flattened to their text so
 * a streamed reply reads the same as a checkpointed one.
 */
function formatChatMessage(message: BaseMessage): string {
  if (Array.isArray(message.content)) {
    const blocks = message.content as Array<{ type?: unknown; text?: unknown }>;
    if (blocks.every((block) => block.type === "text")) {
      return blocks.map((block) => String(block.text ?? "")).join("");
    }
  }
  return formatMessage(message);
}

interface ChatState {
  messages: BaseMessage[];
}

/** Milliseconds the primary session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

const ChatSession = defineComponent({
  name: "ChatSession",
  props: {
    prefix: { type: String, required: true },
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    threadId: { type: String, default: undefined },
    onThreadId: {
      type: Function as PropType<(threadId: string) => void>,
      default: undefined,
    },
    inputs: { type: Array as PropType<string[]>, required: true },
    respondValue: {
      type: null as unknown as PropType<unknown>,
      required: false,
    },
    fetch: {
      type: Function as PropType<typeof globalThis.fetch>,
      default: undefined,
    },
    transport: {
      type: String as PropType<"sse" | "websocket">,
      default: undefined,
    },
  },
  setup(props) {
    const completed = ref(0);
    const respondError = ref("");
    const submitError = ref("");
    const thread = useStream<ChatState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId: () => props.threadId,
      onThreadId: props.onThreadId,
      fetch: props.fetch,
      transport: props.transport,
      onCompleted: () => {
        completed.value += 1;
      },
    });

    const lastText = computed(() => {
      const messages = thread.messages.value;
      return messages.length > 0
        ? formatChatMessage(messages[messages.length - 1])
        : "";
    });

    const countHistory = ref<number[]>([]);
    watch(
      () =>
        [thread.isThreadLoading.value, thread.messages.value.length] as const,
      ([isThreadLoading, count]) => {
        if (isThreadLoading) return;
        if (countHistory.value.at(-1) === count) return;
        countHistory.value = [...countHistory.value, count];
      },
      { immediate: true }
    );

    const settledWith = ref<string[]>([]);
    watch(
      () => thread.isLoading.value,
      (isLoading, wasLoading) => {
        if (wasLoading && !isLoading) {
          settledWith.value = [...settledWith.value, lastText.value];
        }
      }
    );

    const id = (name: string) => `${props.prefix}${name}`;

    return () => (
      <div>
        <div data-testid={id("message-count")}>
          {thread.messages.value.length}
        </div>
        <div data-testid={id("transcript")}>
          {thread.messages.value.map(formatChatMessage).join(" | ")}
        </div>
        <div data-testid={id("ai-tool-calls")}>
          {thread.messages.value
            .filter((message) => AIMessage.isInstance(message))
            .flatMap(
              (message) =>
                (message as AIMessage).tool_calls?.map((call) => call.id) ?? []
            )
            .join(",")}
        </div>
        <div data-testid={id("loading")}>
          {thread.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid={id("thread-loading")}>
          {thread.isThreadLoading.value ? "Hydrating..." : "Ready"}
        </div>
        <div data-testid={id("interrupt-count")}>
          {thread.interrupts.value.length}
        </div>
        <div data-testid={id("error")}>
          {thread.error.value ? String(thread.error.value) : ""}
        </div>
        <div data-testid={id("respond-error")}>{respondError.value}</div>
        <div data-testid={id("submit-error")}>{submitError.value}</div>
        <div data-testid={id("count-history")}>
          {countHistory.value.join(",")}
        </div>
        <div data-testid={id("settled-with")}>
          {settledWith.value.join(" || ")}
        </div>
        <div data-testid={id("completed-count")}>{completed.value}</div>
        {props.inputs.map((input, i) => (
          <button
            key={input}
            data-testid={id(`submit-${i}`)}
            onClick={() => {
              submitError.value = "";
              void thread
                .submit({ messages: [new HumanMessage(input)] })
                .catch((error: unknown) => {
                  submitError.value =
                    error instanceof Error ? error.message : String(error);
                });
            }}
          >
            {input}
          </button>
        ))}
        <button data-testid={id("stop")} onClick={() => void thread.stop()}>
          Stop
        </button>
        <button
          data-testid={id("respond")}
          onClick={() => {
            respondError.value = "";
            void thread.respond(props.respondValue).catch((error: unknown) => {
              respondError.value =
                error instanceof Error ? error.message : String(error);
            });
          }}
        >
          Respond
        </button>
      </div>
    );
  },
});

/**
 * Chat harness for streaming regressions that only show up across views of
 * one thread:
 *
 * - `reload` unmounts the primary `useStream` and mounts a fresh one on the
 *   same thread, like a page refresh.
 * - `observer-mount` opens a second, independent `useStream` on the thread,
 *   like another tab. Its test ids are prefixed with `observer-`.
 *
 * Each session also records what a user would have seen over time:
 * `count-history` lists every message count shown once hydration finished,
 * and `settled-with` the last message shown each time `isLoading` cleared.
 */
export const ChatSessionHarness = defineComponent({
  name: "ChatSessionHarness",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    /** One `submit-<i>` button per entry, sending it as a human message. */
    inputs: {
      type: Array as PropType<string[]>,
      default: () => ["Hello"],
    },
    /** Payload of the `respond` button. */
    respondValue: {
      type: null as unknown as PropType<unknown>,
      required: false,
    },
    /**
     * Give the primary session LangGraph Platform's durable event history:
     * every `/stream/events` open replays what earlier opens received.
     */
    replay: {
      type: Object as PropType<Omit<DurableReplayFetchOptions, "baseFetch">>,
      default: undefined,
    },
    transport: {
      type: String as PropType<"sse" | "websocket">,
      default: undefined,
    },
  },
  setup(props) {
    const durable = props.replay
      ? createDurableReplayFetch(props.replay)
      : undefined;
    const threadId = ref<string>();
    const session = ref(0);
    const mounted = ref(true);
    const observer = ref(false);
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
        <div data-testid="thread-id">{threadId.value ?? "none"}</div>
        <button data-testid="reload" onClick={reload}>
          Reload
        </button>
        <button
          data-testid="observer-mount"
          disabled={threadId.value == null}
          onClick={() => {
            observer.value = true;
          }}
        >
          Open observer
        </button>
        {mounted.value ? (
          <ChatSession
            key={session.value}
            prefix=""
            apiUrl={props.apiUrl}
            assistantId={props.assistantId}
            threadId={threadId.value}
            onThreadId={(id: string) => {
              threadId.value = id;
            }}
            inputs={props.inputs}
            respondValue={props.respondValue}
            fetch={durable?.fetch}
            transport={props.transport}
          />
        ) : null}
        {observer.value && threadId.value != null ? (
          <ChatSession
            prefix="observer-"
            apiUrl={props.apiUrl}
            assistantId={props.assistantId}
            threadId={threadId.value}
            inputs={props.inputs}
            respondValue={props.respondValue}
          />
        ) : null}
      </div>
    );
  },
});
