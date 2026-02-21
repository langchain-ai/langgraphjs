import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="tool-calls-count">{{ stream.toolCalls().length }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ToolCallsComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Hello", type: "human" }] } as any
    );
  }
}
