import { Component } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="message-count">{{ stream.messages().length }}</div>
      <div data-testid="queue-size">{{ stream.queue.size() }}</div>
      <div data-testid="queue-entries">
        {{ queueEntriesStr() }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="submit-three" (click)="onSubmitThree()">
        Submit Three
      </button>
      <button data-testid="cancel-first" (click)="onCancelFirst()">
        Cancel First
      </button>
      <button data-testid="clear-queue" (click)="onClearQueue()">
        Clear Queue
      </button>
      <button data-testid="switch-thread" (click)="onSwitchThread()">
        Switch Thread
      </button>
    </div>
  `,
})
export class QueueStreamComponent {
  stream = injectStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    fetchStateHistory: false,
  });

  queueEntriesStr() {
    return this.stream.queue
      .entries()
      .map((e) => {
        const msgs = e.values?.messages;
        const first = Array.isArray(msgs) ? msgs[0] : undefined;
        return first?.content ?? "?";
      })
      .join(",");
  }

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hi", type: "human" }],
    } as any);
  }

  onSubmitThree() {
    void this.stream.submit({
      messages: [{ content: "Msg1", type: "human" }],
    } as any);
    void this.stream.submit({
      messages: [{ content: "Msg2", type: "human" }],
    } as any);
    void this.stream.submit({
      messages: [{ content: "Msg3", type: "human" }],
    } as any);
  }

  onCancelFirst() {
    const first = this.stream.queue.entries()[0];
    if (first) void this.stream.queue.cancel(first.id);
  }

  onClearQueue() {
    void this.stream.queue.clear();
  }

  onSwitchThread() {
    this.stream.switchThread(crypto.randomUUID());
  }
}
