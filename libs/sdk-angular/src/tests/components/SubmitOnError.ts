import { Component, signal } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

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

  stream = injectStream({
    assistantId: "errorAgent",
    apiUrl: serverUrl,
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Hello", type: "human" }] } as any,
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
