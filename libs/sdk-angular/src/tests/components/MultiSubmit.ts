import { Component, input } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <div data-testid="messages">
        @for (msg of fmtMessages(); track $index) {
          <div [attr.data-testid]="'message-' + $index">
            <span>{{ msg }}</span>
          </div>
        }
      </div>
      <button data-testid="submit-first" (click)="onSubmitFirst()">
        Send First
      </button>
      <button data-testid="submit-second" (click)="onSubmitSecond()">
        Send Second
      </button>
    </div>
  `,
})
export class MultiSubmitComponent {
  onRender = input<((msgs: string[]) => void) | undefined>(undefined);

  stream = useStream({ assistantId: "agent", apiUrl: serverUrl });

  fmtMessages() {
    const msgs = this.stream.messages().map(
      (msg) =>
        `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`
    );
    this.onRender()?.(msgs);
    return msgs;
  }

  onSubmitFirst() {
    void this.stream.submit({
      messages: [{ content: "Hello (1)", type: "human" }],
    } as any);
  }

  onSubmitSecond() {
    void this.stream.submit({
      messages: [{ content: "Hello (2)", type: "human" }],
    } as any);
  }
}
