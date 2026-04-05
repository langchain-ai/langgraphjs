import { Component } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="tool-calls-count">{{ stream.toolCalls().length }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ToolCallsComponent {
  stream = injectStream({
    assistantId: "headlessToolAgent",
    apiUrl: serverUrl,
  });

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Where am I?", type: "human" }],
    } as any);
  }
}
