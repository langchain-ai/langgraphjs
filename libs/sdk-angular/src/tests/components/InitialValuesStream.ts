import { Component } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface InitialValuesState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

let initialValuesFixture: InitialValuesState = { messages: [] };
export function setInitialValuesFixture(values: InitialValuesState): void {
  initialValuesFixture = values;
}

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
      <div data-testid="values">{{ toJson(stream.values()) }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
    </div>
  `,
})
export class InitialValuesComponent {
  stream = injectStream<InitialValuesState>({
    assistantId: "agent",
    apiUrl: serverUrl,
    initialValues: initialValuesFixture,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  toJson(v: unknown) {
    return JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Fresh request")],
    });
  }
}

export const InitialValuesStreamComponent = InitialValuesComponent;
