import { Component, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="thread-id">{{ threadId() ?? "none" }}</div>
      <div data-testid="message-count">{{ stream.messages().length }}</div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class WebSocketBasicStreamComponent {
  readonly threadId = signal<string | null>(null);

  readonly stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl: serverUrl,
    transport: "websocket",
    onThreadId: (id) => this.threadId.set(id),
  });

  str(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit(): void {
    void this.stream.submit({ messages: [new HumanMessage("Hello")] });
  }
}
