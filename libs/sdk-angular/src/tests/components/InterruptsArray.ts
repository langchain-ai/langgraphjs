import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="interrupts-count">{{ stream.interrupts().length }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class InterruptsArrayComponent {
  stream = useStream({
    assistantId: "interruptAgent",
    apiUrl: serverUrl,
    fetchStateHistory: false,
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Hello", type: "human" }] } as any,
      { interruptBefore: ["beforeInterrupt"] }
    );
  }
}
