import { Component, input, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  selector: "lg-secondary-reattach-stream",
  template: `
    <div data-testid="secondary-mounted">yes</div>
    <div data-testid="secondary-loading">
      {{ secondary.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="secondary-thread-id">
      {{ secondary.threadId() ?? "none" }}
    </div>
    <div data-testid="secondary-message-count">
      {{ secondary.messages().length }}
    </div>
  `,
})
class SecondaryReattachStreamComponent {
  readonly threadId = input<string | undefined>(undefined);

  readonly secondary = injectStream<StreamState>({
    assistantId: "slow_graph",
    apiUrl: serverUrl,
    threadId: this.threadId,
  });
}

@Component({
  imports: [SecondaryReattachStreamComponent],
  template: `
    <div>
      <div data-testid="primary-loading">
        {{ primary.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="primary-thread-id">{{ threadId() ?? "none" }}</div>
      <div data-testid="primary-message-count">{{ primary.messages().length }}</div>
      <button data-testid="primary-submit" (click)="onSubmit()">
        Start slow run
      </button>
      <button
        data-testid="secondary-mount"
        [disabled]="threadId() == null"
        (click)="mountSecondary()"
      >
        Mount secondary
      </button>
      <button data-testid="secondary-unmount" (click)="unmountSecondary()">
        Unmount secondary
      </button>
      @if (secondaryMounted() && threadId(); as id) {
        <lg-secondary-reattach-stream [threadId]="id" />
      } @else {
        <div data-testid="secondary-mounted">no</div>
      }
    </div>
  `,
})
export class ReattachStreamComponent {
  readonly threadId = signal<string | null>(null);
  readonly secondaryMounted = signal(false);

  readonly primary = injectStream<StreamState>({
    assistantId: "slow_graph",
    apiUrl: serverUrl,
    threadId: this.threadId,
    onThreadId: (id) => this.threadId.set(id),
  });

  onSubmit(): void {
    void this.primary.submit({ messages: [new HumanMessage("Hello")] });
  }

  mountSecondary(): void {
    this.secondaryMounted.set(true);
  }

  unmountSecondary(): void {
    this.secondaryMounted.set(false);
  }
}
