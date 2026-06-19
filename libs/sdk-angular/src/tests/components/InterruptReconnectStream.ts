import {
  Component,
  Injectable,
  computed,
  inject as angularInject,
  signal,
} from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject as vitestInject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = vitestInject("serverUrl");

/**
 * Reconnect state shared across remounts of the view. Lives in DI so the
 * captured `threadId` survives the `@for`-driven recreation that simulates
 * a fresh `injectStream` on reconnect.
 */
@Injectable()
class InterruptHarnessState {
  readonly threadId = signal<string | undefined>(undefined);
  readonly gen = signal(0);
  readonly genList = computed(() => [this.gen()]);

  readonly onThreadId = (id: string): void => this.threadId.set(id);

  reconnect(): void {
    this.gen.update((g) => g + 1);
  }
}

@Component({
  selector: "lg-interrupt-view",
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      <button data-testid="submit" (click)="submit()">Send</button>
    </div>
  `,
})
class InterruptViewComponent {
  readonly stream: ReturnType<
    typeof injectStream<{ messages: BaseMessage[] }, { nodeName: string }>
  >;

  constructor() {
    const state = angularInject(InterruptHarnessState);
    this.stream = injectStream<
      { messages: BaseMessage[] },
      { nodeName: string }
    >({
      assistantId: "interruptAgent",
      apiUrl: serverUrl,
      threadId: state.threadId,
      onThreadId: state.onThreadId,
    });
  }

  submit(): void {
    void this.stream.submit({ messages: [new HumanMessage("ship it")] });
  }
}

@Component({
  selector: "lg-interrupt-reconnect",
  imports: [InterruptViewComponent],
  providers: [InterruptHarnessState],
  template: `
    <div>
      <button
        data-testid="reconnect"
        [disabled]="state.threadId() == null"
        (click)="state.reconnect()"
      >
        Reconnect
      </button>
      @for (g of state.genList(); track g) {
        <lg-interrupt-view />
      }
    </div>
  `,
})
export class InterruptReconnectHarnessComponent {
  readonly state = angularInject(InterruptHarnessState);
}
