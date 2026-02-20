import { Component, input } from "@angular/core";
import type { Message } from "@langchain/langgraph-sdk";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="stopped-status">
        {{ stopped ? 'Stopped' : 'Not stopped' }}
      </div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">{{ str(msg.content) }}</div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStopClick()">Stop</button>
    </div>
  `,
})
export class StopMutateComponent {
  onStopMutate = input<(prev: any) => any>((prev) => prev);

  stopped = false;

  stream = useStream<{ messages: Message[] }>({
    assistantId: "agent",
    apiUrl: serverUrl,
    onStop: ({ mutate }: any) => {
      this.stopped = true;
      mutate(this.onStopMutate());
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }

  onStopClick() {
    void this.stream.stop();
  }
}
