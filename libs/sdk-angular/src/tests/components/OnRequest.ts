import { Component, input } from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

// eslint-disable-next-line import/no-mutable-exports
export let onRequestCalls: Array<[string, unknown]> = [];

export function resetOnRequestCalls() {
  onRequestCalls = [];
}

const client = new Client({
  apiUrl: serverUrl,
  onRequest: (url, init) => {
    onRequestCalls.push([
      url.toString(),
      {
        ...init,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      },
    ]);
    return init;
  },
});

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
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class OnRequestComponent {
  threadId = input<string | undefined>(undefined);

  stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl: serverUrl,
    client,
    threadId: this.threadId,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
    });
  }
}
