import { Component, input, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  StreamSubmitOptions,
  WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

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
      <div data-testid="thread-id">{{ threadId() ?? "none" }}</div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStop()">Stop</button>
    </div>
  `,
})
export class BasicStreamComponent {
  submitInput = input<WidenUpdateMessages<Partial<StreamState>>>({
    messages: [new HumanMessage("Hello")],
  });

  submitOptions = input<StreamSubmitOptions<StreamState> | undefined>(undefined);

  onThreadIdCallback = input<((id: string) => void) | undefined>(undefined);

  onCreatedCallback = input<
    ((meta: { run_id: string; thread_id: string }) => void) | undefined
  >(undefined);

  threadId = signal<string | null>(null);

  stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl: serverUrl,
    onThreadId: (id) => {
      this.threadId.set(id);
      this.onThreadIdCallback()?.(id);
    },
    onCreated: (meta) => this.onCreatedCallback()?.(meta),
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit(this.submitInput(), this.submitOptions());
  }

  onStop() {
    void this.stream.stop();
  }
}
