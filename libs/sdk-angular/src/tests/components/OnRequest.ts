import { Component } from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

export let onRequestCalls: any[][] = [];

export function resetOnRequestCalls() {
  onRequestCalls = [];
}

const client = new Client({
  apiUrl: serverUrl,
  onRequest: (url: any, init: any) => {
    onRequestCalls.push([
      url.toString(),
      {
        ...init,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      },
    ]);
    return init;
  },
});

@Component({
  standalone: true,
  template: `
    <div>
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
export class OnRequestComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    client,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
