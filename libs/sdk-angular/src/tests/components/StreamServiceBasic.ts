import { Component, Injectable, inject, input } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  StreamSubmitOptions,
  WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";
import { inject as vitestInject } from "vitest";
import { StreamService } from "../../index.js";

const serverUrl = vitestInject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Injectable()
class TestStreamService extends StreamService<StreamState> {
  constructor() {
    super({
      assistantId: "agent",
      apiUrl: serverUrl,
    });
  }
}

@Component({
  providers: [TestStreamService],
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of svc.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <div data-testid="loading">
        {{ svc.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (svc.error()) {
        <div data-testid="error">{{ svc.error() }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStop()">Stop</button>
    </div>
  `,
})
export class StreamServiceBasicComponent {
  submitInput = input<WidenUpdateMessages<Partial<StreamState>>>({
    messages: [new HumanMessage("Hello")],
  });

  submitOptions = input<StreamSubmitOptions<StreamState> | undefined>(undefined);

  svc = inject(TestStreamService);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.svc.submit(this.submitInput(), this.submitOptions());
  }

  onStop() {
    void this.svc.stop();
  }
}
