import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { useStream } from "../../index.js";

interface CardState {
  messages: BaseMessage[];
  toolArg: string;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/** Pull the card + content out of the AIMessage the interrupt carried. */
function readInterrupt(value: unknown): {
  content: string;
  cards: unknown;
} {
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
  const metadata = message.response_metadata as
    | { cards?: unknown }
    | undefined;
  return metadata?.cards != null;
}

/**
 * Reproduces the customer HITL flow against `interrupt_card_graph`:
 * the interrupt (raised from a tool) carries an AIMessage card; on
 * decision the frontend resolves the interrupt AND pushes that card into
 * state in a single atomic `respond(..., { update })`, so the card stays
 * visible while the slow tool runs and the backend never has to add it.
 */
export function InterruptCardStream({
  apiUrl,
  assistantId = "interrupt_card_graph",
}: Props) {
  const thread = useStream<CardState>({ assistantId, apiUrl });

  const { content, cards } = readInterrupt(thread.interrupt?.value);

  // The AIMessage the frontend pushes into state on respond — the same
  // card the interrupt carried (built as a `BaseMessage` instance to
  // exercise the instance-serialization path).
  const buildCardMessage = () =>
    new AIMessage({ content, response_metadata: { cards } });

  const cardMessages = thread.messages.filter(isCardMessage);

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-card">
        {cards != null ? JSON.stringify(cards) : "none"}
      </div>
      <div data-testid="loading">{thread.isLoading ? "loading" : "idle"}</div>
      <div data-testid="card-count">{cardMessages.length}</div>
      <div data-testid="card-in-state">
        {cardMessages.length > 0 ? "present" : "absent"}
      </div>
      <div data-testid="messages">
        {thread.messages
          .map(
            (m) =>
              `${m.getType()}:${
                typeof m.content === "string" ? m.content : ""
              }`
          )
          .join("|")}
      </div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit({ toolArg: "delete_db" })}
      >
        Submit
      </button>
      <button
        data-testid="approve"
        onClick={() => {
          if (thread.interrupt) {
            void thread.respond(
              { approved: true },
              { update: { messages: [buildCardMessage()] } }
            );
          }
        }}
      >
        Approve
      </button>
      <button
        data-testid="reject"
        onClick={() => {
          if (thread.interrupt) {
            void thread.respond(
              { approved: false },
              { update: { messages: [buildCardMessage()] } }
            );
          }
        }}
      >
        Reject
      </button>
    </div>
  );
}
