import { Component, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream, injectSubmissionQueue } from "../../index.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

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
      <div data-testid="queue-size">{{ queue.size() }}</div>
      <div data-testid="queue-entries">
        {{ queueEntriesStr() }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="submit-first" (click)="onSubmitFirst()">
        Submit First
      </button>
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
  private readonly threadId = signal<string | null>(null);

  stream = injectStream<StreamState>({
    assistantId: "slow_graph",
    apiUrl: serverUrl,
    threadId: this.threadId,
    onThreadId: (id) => this.threadId.set(id),
  });

  queue = injectSubmissionQueue(this.stream);

  queueEntriesStr() {
    return this.queue
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
    this.submitEnqueue("Hi");
  }

  onSubmitFirst() {
    this.submitEnqueue("Msg1");
  }

  private submitEnqueue(content: string) {
    void this.stream.submit({
      messages: [new HumanMessage(content)],
    }, {
      multitaskStrategy: "enqueue",
    });
  }

  onSubmitThree() {
    this.submitEnqueue("Msg2");
    this.submitEnqueue("Msg3");
    this.submitEnqueue("Msg4");
  }

  onCancelFirst() {
    const first = this.queue.entries()[0];
    if (first) void this.queue.cancel(first.id);
  }

  onClearQueue() {
    void this.queue.clear();
  }

  onSwitchThread() {
    this.threadId.set(crypto.randomUUID());
  }
}
