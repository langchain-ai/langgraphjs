import { Component, Injectable, inject, input } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  StreamSubmitOptions,
  WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";
import { inject as vitestInject } from "vitest";
import { StreamService, injectMessages } from "../../index.js";

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

@Injectable()
class ErrorStreamService extends StreamService<StreamState> {
  constructor() {
    super({
      assistantId: "errorAgent",
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
          <div [attr.data-testid]="'svc-message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <div data-testid="message-count">{{ svc.messages().length }}</div>
      <div data-testid="selector-message-count">
        {{ selectorMessages().length }}
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
  selectorMessages = injectMessages(this.svc.stream);

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

@Component({
  providers: [ErrorStreamService],
  template: `
    <div>
      <div data-testid="loading">
        {{ svc.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (svc.error()) {
        <div data-testid="error">{{ svc.error() }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class StreamServiceErrorComponent {
  svc = inject(ErrorStreamService);

  onSubmit() {
    void this.svc.submit({
      messages: [new HumanMessage("Hello")],
    });
  }
}
