import { Component } from "@angular/core";
import { inject as vitestInject } from "vitest";
import { provideStream, injectStream } from "../../index.js";

const serverUrl = vitestInject("serverUrl");

@Component({
  selector: "app-message-list",
  template: `
    <div data-testid="messages">
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div [attr.data-testid]="'message-' + $index">
          {{ str(msg.content) }}
        </div>
      }
    </div>
  `,
})
export class MessageListComponent {
  stream = injectStream();

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}

@Component({
  selector: "app-status-bar",
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }
    </div>
  `,
})
export class StatusBarComponent {
  stream = injectStream();
}

@Component({
  selector: "app-submit-button",
  template: `
    <div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStop()">Stop</button>
    </div>
  `,
})
export class SubmitButtonComponent {
  stream = injectStream();

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    });
  }

  onStop() {
    void this.stream.stop();
  }
}

@Component({
  selector: "app-context-provider",
  imports: [MessageListComponent, StatusBarComponent, SubmitButtonComponent],
  providers: [provideStream({ assistantId: "agent", apiUrl: serverUrl })],
  template: `
    <div>
      <app-message-list />
      <app-status-bar />
      <app-submit-button />
    </div>
  `,
})
export class ContextProviderComponent {}
