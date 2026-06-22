import { computed, defineComponent } from "vue";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface CardState {
  messages: BaseMessage[];
  toolArg: string;
}

/** Pull the card + content out of the AIMessage the interrupt carried. */
function readInterrupt(value: unknown): { content: string; cards: unknown } {
  if (value != null && typeof value === "object") {
    const v = value as {
      content?: unknown;
      response_metadata?: { cards?: unknown };
    };
    return {
      content: typeof v.content === "string" ? v.content : "",
      cards: v.response_metadata?.cards ?? null,
    };
  }
  return { content: "", cards: null };
}

function isCardMessage(message: BaseMessage): boolean {
  if (message.getType() !== "ai") return false;
  const metadata = message.response_metadata as { cards?: unknown } | undefined;
  return metadata?.cards != null;
}

/**
 * Reproduces the customer HITL flow against `interrupt_card_graph`:
 * the interrupt (raised from a tool) carries an AIMessage card; on
 * decision the frontend resolves the interrupt AND pushes that card into
 * state in a single atomic `respond(..., { update })`, so the card stays
 * visible while the slow tool runs and the backend never has to add it.
 */
export const InterruptCardStream = defineComponent({
  name: "InterruptCardStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "interrupt_card_graph" },
  },
  setup(props) {
    const stream = useStream<CardState>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
    });

    const interruptInfo = computed(() =>
      readInterrupt(stream.interrupt.value?.value),
    );
    const cardMessages = computed(() =>
      stream.messages.value.filter(isCardMessage),
    );

    // The AIMessage the frontend pushes into state on respond — the same
    // card the interrupt carried (built as a `BaseMessage` instance to
    // exercise the instance-serialization path).
    const buildCardMessage = () =>
      new AIMessage({
        content: interruptInfo.value.content,
        response_metadata: { cards: interruptInfo.value.cards },
      });

    return () => (
      <div>
        <div data-testid="interrupt-count">
          {stream.interrupts.value.length}
        </div>
        <div data-testid="interrupt-card">
          {interruptInfo.value.cards != null
            ? JSON.stringify(interruptInfo.value.cards)
            : "none"}
        </div>
        <div data-testid="loading">
          {stream.isLoading.value ? "loading" : "idle"}
        </div>
        <div data-testid="card-count">{cardMessages.value.length}</div>
        <div data-testid="card-in-state">
          {cardMessages.value.length > 0 ? "present" : "absent"}
        </div>
        <div data-testid="messages">
          {stream.messages.value
            .map(
              (m) =>
                `${m.getType()}:${
                  typeof m.content === "string" ? m.content : ""
                }`,
            )
            .join("|")}
        </div>
        <button
          data-testid="submit"
          onClick={() => void stream.submit({ toolArg: "delete_db" })}
        >
          Submit
        </button>
        <button
          data-testid="approve"
          onClick={() => {
            if (stream.interrupt.value) {
              void stream.respond(
                { approved: true },
                { update: { messages: [buildCardMessage()] } },
              );
            }
          }}
        >
          Approve
        </button>
        <button
          data-testid="reject"
          onClick={() => {
            if (stream.interrupt.value) {
              void stream.respond(
                { approved: false },
                { update: { messages: [buildCardMessage()] } },
              );
            }
          }}
        >
          Reject
        </button>
      </div>
    );
  },
});
