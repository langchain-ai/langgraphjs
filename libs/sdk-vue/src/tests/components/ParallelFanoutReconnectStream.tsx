import {
  defineComponent,
  onScopeDispose,
  ref,
  watchEffect,
  type PropType,
} from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  STREAM_CONTROLLER,
  useMessages,
  useStream,
  useToolCalls,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
} from "../../index.js";

type Thread = ReturnType<typeof useStream<{ messages: BaseMessage[] }>>;
type Card = SubagentDiscoverySnapshot | SubgraphDiscoverySnapshot;
type Kind = "subagent" | "subgraph";

function cardKey(card: Card): string {
  return card.namespace.join("/") || card.id;
}

/**
 * Vue port of the React parallel fan-out reconnect harness. Runs a
 * fan-out to completion, then a "reconnect" remounts a fresh
 * `useStream` (keyed child) against the same thread to exercise the
 * hydrate seeding path. A wrapping `fetch` counts `/history` POSTs so
 * the test can assert the bounded getHistory invariant.
 */
export const ParallelFanoutReconnectStream = defineComponent({
  name: "ParallelFanoutReconnectStream",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    kind: { type: String as PropType<Kind>, required: true },
    openAll: { type: Boolean, default: false },
    openAllAfterReconnect: { type: Boolean, default: false },
  },
  setup(props) {
    const threadId = ref<string | undefined>(undefined);
    const gen = ref(0);
    const historyCount = ref(0);

    const wrappedFetch: typeof fetch = (input, init) => {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        if (typeof url === "string" && url.includes("/history")) {
          historyCount.value += 1;
        }
      } catch {
        /* ignore */
      }
      return fetch(input, init);
    };

    return () => (
      <div>
        <button
          data-testid="reconnect"
          disabled={threadId.value == null}
          onClick={() => {
            historyCount.value = 0;
            gen.value += 1;
          }}
        >
          Reconnect
        </button>
        <StreamView
          key={gen.value}
          apiUrl={props.apiUrl}
          assistantId={props.assistantId}
          kind={props.kind}
          openAll={
            props.openAll || (props.openAllAfterReconnect && gen.value > 0)
          }
          threadId={threadId.value}
          onThreadId={(id: string) => {
            threadId.value = id;
          }}
          wrappedFetch={wrappedFetch}
          historyCount={historyCount}
        />
      </div>
    );
  },
});

const StreamView = defineComponent({
  name: "StreamView",
  props: {
    apiUrl: { type: String, required: true },
    assistantId: { type: String, required: true },
    kind: { type: String as PropType<Kind>, required: true },
    openAll: { type: Boolean, default: false },
    threadId: { type: String, default: undefined },
    onThreadId: {
      type: Function as PropType<(id: string) => void>,
      required: true,
    },
    wrappedFetch: {
      type: Function as PropType<typeof fetch>,
      required: true,
    },
    historyCount: {
      type: Object as PropType<{ value: number }>,
      required: true,
    },
  },
  setup(props) {
    const thread = useStream<{ messages: BaseMessage[] }>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      threadId: props.threadId,
      onThreadId: props.onThreadId,
      fetch: props.wrappedFetch,
    });

    const openKey = ref<string | null>(null);
    const tick = ref(0);
    const handle = setInterval(() => {
      tick.value += 1;
    }, 25);
    onScopeDispose(() => clearInterval(handle));

    // Count of mounted panels whose scoped messages have landed — lets
    // the "open all" test wait for every card's lazy resolve to settle.
    const readySet = new Set<string>();
    const readyCount = ref(0);
    const markReady = (key: string, ready: boolean) => {
      if (ready === readySet.has(key)) return;
      if (ready) readySet.add(key);
      else readySet.delete(key);
      readyCount.value = readySet.size;
    };

    return () => {
      void tick.value;
      const cards: Card[] = (
        props.kind === "subagent"
          ? [...thread.subagents.value.values()]
          : [...thread.subgraphs.value.values()]
      )
        .slice()
        .sort((a, b) => cardKey(a).localeCompare(cardKey(b)));
      const openCard = cards.find((c) => cardKey(c) === openKey.value) ?? null;

      return (
        <div>
          <div data-testid="loading">
            {thread.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="subagent-count">{thread.subagents.value.size}</div>
          <div data-testid="subgraph-count">{thread.subgraphs.value.size}</div>
          <div data-testid="card-count">{cards.length}</div>
          <div data-testid="card-statuses">
            {cards.map((c) => c.status).join(",")}
          </div>
          <div data-testid="panels-ready">{readyCount.value}</div>
          <div data-testid="registry-size">
            {thread[STREAM_CONTROLLER].registry.size}
          </div>
          <div data-testid="history-request-count">
            {props.historyCount.value}
          </div>

          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [new HumanMessage("Fan out the work")],
              })
            }
          >
            Run
          </button>

          {cards.map((c, i) => (
            <button
              key={cardKey(c)}
              data-testid={`open-${i}`}
              onClick={() => {
                openKey.value = cardKey(c);
              }}
            >
              Open {i}
            </button>
          ))}

          {props.openAll
            ? cards.map((c, i) => (
                <CardPanel
                  key={cardKey(c)}
                  idx={i}
                  stream={thread}
                  card={c}
                  onReady={markReady}
                />
              ))
            : openCard != null
              ? <CardPanel stream={thread} card={openCard} />
              : null}
        </div>
      );
    };
  },
});

const CardPanel = defineComponent({
  name: "CardPanel",
  props: {
    stream: { type: Object as PropType<Thread>, required: true },
    card: { type: Object as PropType<Card>, required: true },
    idx: { type: Number, default: undefined },
    onReady: {
      type: Function as PropType<(key: string, ready: boolean) => void>,
      default: undefined,
    },
  },
  setup(props) {
    const messages = useMessages(props.stream, () => props.card);
    const toolCalls = useToolCalls(props.stream, () => props.card);
    watchEffect(() => {
      props.onReady?.(cardKey(props.card), messages.value.length > 0);
    });
    return () => (
      <div data-testid={props.idx != null ? `panel-${props.idx}` : "panel"}>
        <div data-testid="panel-namespace">{props.card.namespace.join("/")}</div>
        <div data-testid="panel-messages-count">{messages.value.length}</div>
        <div data-testid="panel-toolcalls-count">{toolCalls.value.length}</div>
      </div>
    );
  },
});
