import type { BaseMessage } from "langchain";
import { Component } from "@angular/core";
import { useStreamCustom } from "../../stream.custom.js";

let callCount = 0;

const transport = {
  async stream(payload: any) {
    const threadId = payload.config?.configurable?.thread_id ?? "unknown";
    // eslint-disable-next-line no-plusplus
    const idx = callCount++;
    async function* generate(): AsyncGenerator<{
      event: string;
      data: unknown;
    }> {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      yield {
        event: "values",
        data: {
          messages: [
            {
              id: `${threadId}-human-${idx}`,
              type: "human",
              content: `Question ${idx}`,
            },
            {
              id: `${threadId}-ai-${idx}`,
              type: "ai",
              content: `Answer ${idx}`,
            },
          ],
        },
      };
    }
    return generate();
  },
};

@Component({
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages; track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="message-count">{{ stream.messages.length }}</div>
      <div data-testid="queue-size">{{ stream.queue.size() }}</div>
      <div data-testid="queue-entries">{{ queueEntriesLabel() }}</div>
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
  stream = useStreamCustom<{ messages: BaseMessage[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
    queue: true,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  queueEntriesLabel() {
    return this.stream.queue
      .entries()
      .map((e: any) => {
        const msgs = e.values?.messages;
        return msgs?.[0]?.content ?? "?";
      })
      .join(",");
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hi" }],
    } as any);
  }

  onSubmitThree() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Msg1" }],
    } as any);
    void this.stream.submit({
      messages: [{ type: "human", content: "Msg2" }],
    } as any);
    void this.stream.submit({
      messages: [{ type: "human", content: "Msg3" }],
    } as any);
  }

  onCancelFirst() {
    const entries = this.stream.queue.entries();
    const first = entries[0];
    if (first) this.stream.queue.cancel(first.id);
  }

  onClearQueue() {
    this.stream.queue.clear();
  }

  onSwitchThread() {
    this.stream.switchThread(crypto.randomUUID());
  }
}
