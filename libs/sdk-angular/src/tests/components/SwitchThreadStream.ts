import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { injectStream } from "../../inject-stream.js";
import { formatMessage } from "./format.js";
import { apiUrl } from "./apiUrl.js";

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  selector: "lg-switch-thread-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="message-count">{{ stream.messages().length }}</div>
    <div data-testid="thread-id">{{ stream.threadId() ?? "none" }}</div>
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="messages">
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div [attr.data-testid]="'message-' + $index">
          {{ formatMessage(msg) }}
        </div>
      }
    </div>
    <button data-testid="submit" (click)="onSubmit()">Send</button>
    <button data-testid="switch-thread" (click)="switchToNew()">Switch</button>
    <button data-testid="switch-thread-null" (click)="clearThread()">Clear</button>
  `,
})
export class SwitchThreadStreamComponent {
  readonly formatMessage = formatMessage;

  readonly initialThreadId = input<string | null | undefined>(undefined);

  private readonly selectedThreadId = signal<string | null | undefined>(
    undefined
  );

  private readonly threadId = computed(() => {
    const selected = this.selectedThreadId();
    return selected === undefined ? (this.initialThreadId() ?? null) : selected;
  });

  readonly stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl,
    threadId: this.threadId,
    onThreadId: (id) => {
      // Only record a *new* id; do not clobber ids the user set
      // via `switchToNew()` (which writes the signal itself).
      if (this.threadId() == null) this.selectedThreadId.set(id);
    },
  });

  onSubmit(): void {
    void this.stream.submit({ messages: [new HumanMessage("Hello")] });
  }

  switchToNew(): void {
    this.selectedThreadId.set(crypto.randomUUID());
  }

  clearThread(): void {
    this.selectedThreadId.set(null);
  }
}
