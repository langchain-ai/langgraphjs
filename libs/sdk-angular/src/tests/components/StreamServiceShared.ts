import { Component, Injectable, inject } from "@angular/core";
import { inject as vitestInject } from "vitest";
import { StreamService } from "../../index.js";

const serverUrl = vitestInject("serverUrl");

@Injectable()
export class SharedStreamService extends StreamService {
  constructor() {
    super({
      assistantId: "agent",
      apiUrl: serverUrl,
    });
  }
}

@Component({
  selector: "app-message-list",
  template: `
    <div data-testid="child-messages">
      @for (msg of svc.messages(); track msg.id ?? $index) {
        <div [attr.data-testid]="'child-message-' + $index">
          {{ str(msg.content) }}
        </div>
      }
    </div>
    <div data-testid="child-loading">
      {{ svc.isLoading() ? "Loading..." : "Not loading" }}
    </div>
  `,
})
export class MessageListComponent {
  svc = inject(SharedStreamService);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}

@Component({
  imports: [MessageListComponent],
  providers: [SharedStreamService],
  template: `
    <div>
      <div data-testid="parent-loading">
        {{ svc.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="parent-message-count">
        {{ svc.messages().length }}
      </div>

      <app-message-list />

      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class StreamServiceSharedComponent {
  svc = inject(SharedStreamService);

  onSubmit() {
    void this.svc.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
