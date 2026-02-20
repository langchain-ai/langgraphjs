import { Component, input } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

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
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStop()">Stop</button>
    </div>
  `,
})
export class BasicStreamComponent {
  submitInput = input<Record<string, unknown>>({
    messages: [{ content: "Hello", type: "human" }],
  });

  submitOptions = input<Record<string, unknown> | undefined>(undefined);

  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit(
      this.submitInput() as any,
      this.submitOptions() as any
    );
  }

  onStop() {
    void this.stream.stop();
  }
}
