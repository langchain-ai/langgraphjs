import {
  Component,
  Injectable,
  computed,
  inject as angularInject,
  signal,
} from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
          </div>
        }
        @if (stream.messages().length > 0) {
          <div data-testid="last-message">
            {{
              str(stream.messages()[stream.messages().length - 1].content)
            }}
          </div>
        }
      </div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      @if (stream.interrupt()) {
        <div>
          <div data-testid="interrupt">
            {{
              stream.interrupt()!.when ??
                stream.interrupt()!.value?.nodeName
            }}
          </div>
          <div data-testid="interrupt-node">
            {{ stream.interrupt()!.value?.nodeName ?? "" }}
          </div>
          <div data-testid="interrupt-id">
            {{ stream.interrupt()!.id }}
          </div>
          <button data-testid="resume" (click)="onResume()">Resume</button>
          <button data-testid="respond" (click)="onRespond()">Respond</button>
        </div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class InterruptComponent {
  stream = injectStream<{ messages: BaseMessage[] }, { nodeName: string }>({
    assistantId: "interruptAgent",
    apiUrl: serverUrl,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
    });
  }

  onResume() {
    void this.stream.respond("Resuming");
  }

  onRespond() {
    void this.stream.respond("Responding");
  }
}

export const InterruptStreamComponent = InterruptComponent;

/**
 * Shared reconnect state for the idle-pumps hydrate harness. Survives the
 * `@for`-driven remount that simulates a fresh `injectStream` on reconnect.
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
  selector: "lg-interrupt-harness-view",
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      @if (stream.interrupt()) {
        <div data-testid="interrupt-id">{{ stream.interrupt()!.id }}</div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
class InterruptHarnessViewComponent {
  readonly #state = angularInject(InterruptHarnessState);

  stream = injectStream<{ messages: BaseMessage[] }, { nodeName: string }>({
    assistantId: "interruptAgent",
    apiUrl: serverUrl,
    threadId: this.#state.threadId,
    onThreadId: this.#state.onThreadId,
  });

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
    });
  }
}

/**
 * Hydrate/reconnect harness for idle-pumps: submit until interrupted, then
 * remount a fresh controller against the same thread id.
 */
@Component({
  selector: "lg-interrupt-reconnect-harness",
  imports: [InterruptHarnessViewComponent],
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
        <lg-interrupt-harness-view />
      }
    </div>
  `,
})
export class InterruptReconnectHarnessComponent {
  readonly state = angularInject(InterruptHarnessState);
}
