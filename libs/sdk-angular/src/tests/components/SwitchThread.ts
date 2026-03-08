import type { BaseMessage } from "langchain";
import { Component } from "@angular/core";
import { useStreamCustom } from "../../stream.custom.js";

const transport = {
  async stream(payload: any) {
    const threadId = payload.config?.configurable?.thread_id ?? "unknown";
    async function* generate(): AsyncGenerator<{
      event: string;
      data: unknown;
    }> {
      yield {
        event: "values",
        data: {
          messages: [
            {
              id: `${threadId}-human`,
              type: "human",
              content: `Hello from ${threadId.slice(0, 8)}`,
            },
            {
              id: `${threadId}-ai`,
              type: "ai",
              content: `Reply on ${threadId.slice(0, 8)}`,
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
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="switch-thread" (click)="onSwitchThread()">
        Switch Thread
      </button>
      <button data-testid="switch-thread-null" (click)="onSwitchThreadNull()">
        Switch to Null Thread
      </button>
    </div>
  `,
})
export class SwitchThreadComponent {
  stream = useStreamCustom<{ messages: BaseMessage[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hi" }],
    } as any);
  }

  onSwitchThread() {
    this.stream.switchThread(crypto.randomUUID());
  }

  onSwitchThreadNull() {
    this.stream.switchThread(null);
  }
}
