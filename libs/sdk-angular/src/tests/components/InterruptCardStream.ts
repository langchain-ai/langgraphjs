import { Component } from "@angular/core";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface CardState {
  messages: BaseMessage[];
  toolArg: string;
}

/**
 * Reproduces the customer HITL flow against `interrupt_card_graph`:
 * the interrupt (raised from a tool) carries an AIMessage card; on
 * decision the frontend resolves the interrupt AND pushes that card into
 * state in a single atomic `respond(..., { update })`, so the card stays
 * visible while the slow tool runs and the backend never has to add it.
 */
@Component({
  template: `
    <div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      <div data-testid="interrupt-card">{{ cardsJson() }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "loading" : "idle" }}
      </div>
      <div data-testid="card-count">{{ cardMessages().length }}</div>
      <div data-testid="card-in-state">
        {{ cardMessages().length > 0 ? "present" : "absent" }}
      </div>
      <div data-testid="messages">{{ messagesStr() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="approve" (click)="onApprove()">Approve</button>
      <button data-testid="reject" (click)="onReject()">Reject</button>
    </div>
  `,
})
export class InterruptCardComponent {
  stream = injectStream<CardState>({
    assistantId: "interrupt_card_graph",
    apiUrl: serverUrl,
  });

  /** Pull the card + content out of the AIMessage the interrupt carried. */
  private interruptInfo(): { content: string; cards: unknown } {
    const value = this.stream.interrupt()?.value as
      | { content?: unknown; response_metadata?: { cards?: unknown } }
      | undefined;
    return {
      content: typeof value?.content === "string" ? value.content : "",
      cards: value?.response_metadata?.cards ?? null,
    };
  }

  cardsJson() {
    const { cards } = this.interruptInfo();
    return cards != null ? JSON.stringify(cards) : "none";
  }

  cardMessages() {
    return this.stream.messages().filter((m) => {
      if (m.getType() !== "ai") return false;
      const metadata = m.response_metadata as { cards?: unknown } | undefined;
      return metadata?.cards != null;
    });
  }

  messagesStr() {
    return this.stream
      .messages()
      .map(
        (m) =>
          `${m.getType()}:${typeof m.content === "string" ? m.content : ""}`,
      )
      .join("|");
  }

  // The AIMessage the frontend pushes into state on respond — the same
  // card the interrupt carried (built as a `BaseMessage` instance to
  // exercise the instance-serialization path).
  private buildCardMessage() {
    const { content, cards } = this.interruptInfo();
    return new AIMessage({ content, response_metadata: { cards } });
  }

  onSubmit() {
    void this.stream.submit({ toolArg: "delete_db" });
  }

  onApprove() {
    if (this.stream.interrupt()) {
      void this.stream.respond(
        { approved: true },
        { update: { messages: [this.buildCardMessage()] } },
      );
    }
  }

  onReject() {
    if (this.stream.interrupt()) {
      void this.stream.respond(
        { approved: false },
        { update: { messages: [this.buildCardMessage()] } },
      );
    }
  }
}

export const InterruptCardStreamComponent = InterruptCardComponent;
