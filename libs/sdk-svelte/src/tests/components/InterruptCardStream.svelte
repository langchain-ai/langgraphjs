<script lang="ts">
  import { AIMessage, type BaseMessage } from "@langchain/core/messages";
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "interrupt_card_graph" }: Props = $props();

  interface CardState {
    messages: BaseMessage[];
    toolArg: string;
  }

  const stream = useStream<CardState>({ assistantId, apiUrl });

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
    const metadata = message.response_metadata as
      | { cards?: unknown }
      | undefined;
    return metadata?.cards != null;
  }

  const info = $derived(readInterrupt(stream.interrupt?.value));
  const cardMessages = $derived(stream.messages.filter(isCardMessage));

  // The AIMessage the frontend pushes into state on respond — the same
  // card the interrupt carried (built as a `BaseMessage` instance to
  // exercise the instance-serialization path).
  const buildCardMessage = () =>
    new AIMessage({
      content: info.content,
      response_metadata: { cards: info.cards },
    });
</script>

<div>
  <div data-testid="interrupt-count">{stream.interrupts.length}</div>
  <div data-testid="interrupt-card">
    {info.cards != null ? JSON.stringify(info.cards) : "none"}
  </div>
  <div data-testid="loading">{stream.isLoading ? "loading" : "idle"}</div>
  <div data-testid="card-count">{cardMessages.length}</div>
  <div data-testid="card-in-state">
    {cardMessages.length > 0 ? "present" : "absent"}
  </div>
  <div data-testid="messages">
    {stream.messages
      .map(
        (m) =>
          `${m.getType()}:${typeof m.content === "string" ? m.content : ""}`,
      )
      .join("|")}
  </div>
  <button
    data-testid="submit"
    onclick={() => void stream.submit({ toolArg: "delete_db" })}
  >
    Submit
  </button>
  <button
    data-testid="approve"
    onclick={() => {
      if (stream.interrupt) {
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
    onclick={() => {
      if (stream.interrupt) {
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
