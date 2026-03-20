import { Component } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

const PRESETS = ["Msg1", "Msg2", "Msg3"];

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
      <div data-testid="queue-size">{{ stream.queue.size() }}</div>
      <button data-testid="submit-presets" (click)="onSubmitPresets()">
        Submit Presets
      </button>
    </div>
  `,
})
export class QueueOnCreatedComponent {
  private pending: string[] = [];

  stream = injectStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    fetchStateHistory: false,
    onCreated: () => {
      if (this.pending.length > 0) {
        const followUps = this.pending;
        this.pending = [];
        for (const text of followUps) {
          void this.stream.submit({
            messages: [{ content: text, type: "human" }],
          } as any);
        }
      }
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmitPresets() {
    this.pending = PRESETS.slice(1);
    void this.stream.submit({
      messages: [{ content: PRESETS[0], type: "human" }],
    } as any);
  }
}
