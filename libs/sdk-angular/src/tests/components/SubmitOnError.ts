import { Component, signal } from "@angular/core";
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
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }
      @if (submitError()) {
        <div data-testid="submit-error">{{ submitError() }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class SubmitOnErrorComponent {
  submitError = signal<string | null>(null);

  stream = injectStream<StreamState>({
    assistantId: "errorAgent",
    apiUrl: serverUrl,
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [new HumanMessage("Hello")] },
      {
        onError: (err: unknown) => {
          this.submitError.set(
            err instanceof Error ? err.message : String(err),
          );
        },
      },
    );
  }
}
