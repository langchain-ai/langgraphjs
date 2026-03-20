import { Component, computed } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="history-count">{{ stream.history().length }}</div>
      <div data-testid="history-all-base-message">
        {{ allAreBaseMessage() }}
      </div>
      <div data-testid="history-message-types">{{ messageTypes() }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class HistoryMessagesComponent {
  stream = injectStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    fetchStateHistory: true,
  });

  historyMessages = computed(() =>
    this.stream
      .history()
      .flatMap(
        (state: any) =>
          (state.values.messages ?? []) as Record<string, unknown>[],
      ),
  );

  allAreBaseMessage = computed(() => {
    const msgs = this.historyMessages();
    return String(
      msgs.length > 0 &&
        msgs.every((msg: any) => typeof msg.getType === "function"),
    );
  });

  messageTypes = computed(() =>
    this.historyMessages()
      .map((msg: any) =>
        typeof msg.getType === "function" ? msg.getType() : "plain",
      )
      .join(","),
  );

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
