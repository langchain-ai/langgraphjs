import { Component, input } from "@angular/core";
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

  stream = injectStream<StreamState>({
    assistantId: "removeMessageAgent",
    apiUrl: serverUrl,
  });

  fmtMessages() {
    const msgs = this.stream
      .messages()
      .map(
        (msg) =>
          `${msg.type}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`,
      );
    this.onRender()?.(msgs);
    return msgs;
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
    });
  }
}
