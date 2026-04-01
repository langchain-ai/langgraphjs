import { Component, input } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StreamSubmitOptions } from "@langchain/langgraph-sdk/stream";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

let pendingSubmitOptions: StreamSubmitOptions<StreamState> | undefined;
export function setMultiSubmitOptions(
  options: StreamSubmitOptions<StreamState> | undefined
): void {
  pendingSubmitOptions = options;
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
      <button data-testid="submit-first" (click)="onSubmitFirst()">
        Send First
      </button>
      <button data-testid="submit-second" (click)="onSubmitSecond()">
        Send Second
      </button>
    </div>
  `,
})
export class MultiSubmitComponent {
  onRender = input<((msgs: string[]) => void) | undefined>(undefined);

  stream = injectStream<StreamState>({ assistantId: "agent", apiUrl: serverUrl });

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

  onSubmitFirst() {
    void this.stream.submit(
      {
        messages: [new HumanMessage("Hello (1)")],
      },
      pendingSubmitOptions
    );
  }

  onSubmitSecond() {
    void this.stream.submit(
      {
        messages: [new HumanMessage("Hello (2)")],
      },
      pendingSubmitOptions
    );
  }
}
