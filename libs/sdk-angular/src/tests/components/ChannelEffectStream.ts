import { Component, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../inject-stream.js";
import { injectChannelEffect } from "../../selectors.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Exercises {@link injectChannelEffect}: each raw event observed on the
 * `custom` channel is pushed into a signal so the test can assert on the
 * delivered count / order.
 */
@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="effect-count">{{ count() }}</div>
      <div data-testid="effect-methods">{{ methods().join(",") }}</div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ChannelEffectStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "customChannelAgent",
    apiUrl: serverUrl,
    initialValues: { messages: [] },
  });

  readonly count = signal(0);
  readonly methods = signal<string[]>([]);

  constructor() {
    injectChannelEffect(this.stream, ["custom"], {
      replay: false,
      onEvent: (event) => {
        this.count.update((value) => value + 1);
        this.methods.update((value) => [...value, event.method ?? ""]);
      },
    });
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Trigger custom writer")],
    });
  }
}

/**
 * Same as {@link ChannelEffectStreamComponent} but with the
 * subscription disabled, so no events should be delivered.
 */
@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="effect-count">{{ count() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class DisabledChannelEffectStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "customChannelAgent",
    apiUrl: serverUrl,
    initialValues: { messages: [] },
  });

  readonly count = signal(0);

  constructor() {
    injectChannelEffect(this.stream, ["custom"], {
      enabled: false,
      replay: false,
      onEvent: () => {
        this.count.update((value) => value + 1);
      },
    });
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Trigger custom writer")],
    });
  }
}
