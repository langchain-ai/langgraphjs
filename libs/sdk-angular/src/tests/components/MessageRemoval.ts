import { Component, input } from "@angular/core";
import type { Message } from "@langchain/langgraph-sdk";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <div data-testid="messages">
        @for (msg of fmtMessages(); track $index) {
          <div [attr.data-testid]="'message-' + $index">
            <span>{{ msg }}</span>
          </div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class MessageRemovalComponent {
  onRender = input<((msgs: string[]) => void) | undefined>(undefined);

  stream = useStream({
    assistantId: "removeMessageAgent",
    apiUrl: serverUrl,
    throttle: false,
  });

  fmtMessages() {
    const msgs = this.stream.messages().map(
      (msg: Message) =>
        `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`
    );
    this.onRender()?.(msgs);
    return msgs;
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
