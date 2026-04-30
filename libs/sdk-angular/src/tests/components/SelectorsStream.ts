import { ChangeDetectionStrategy, Component } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { injectStream } from "../../inject-stream.js";
import {
  injectMessages,
  injectToolCalls,
  injectValues,
} from "../../selectors.js";
import { formatMessage } from "./format.js";
import { apiUrl } from "./apiUrl.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

@Component({
  selector: "lg-selectors-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="messages-count">{{ messages().length }}</div>
    <div data-testid="toolcalls-count">{{ toolCalls().length }}</div>
    <div data-testid="values-json">{{ valuesString() }}</div>
    @for (msg of messages(); track msg.id ?? $index) {
      <div [attr.data-testid]="'selector-message-' + $index">
        {{ format(msg) }}
      </div>
    }
    <button data-testid="submit" (click)="onSubmit()">Send</button>
  `,
})
export class SelectorsStreamComponent {
  readonly format = formatMessage;

  readonly stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl,
  });

  readonly messages = injectMessages(this.stream);
  readonly toolCalls = injectToolCalls(this.stream);
  readonly values = injectValues(this.stream);

  valuesString(): string {
    try {
      return JSON.stringify(this.values());
    } catch {
      return "{}";
    }
  }

  onSubmit(): void {
    void this.stream.submit({ messages: [new HumanMessage("Hello")] });
  }
}
