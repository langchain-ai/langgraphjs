import { Component, computed, input, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import {
  injectMessages,
  injectStream,
  provideStream,
  STREAM_CONTROLLER,
  type SelectorTarget,
} from "../../index.js";
import { formatMessage } from "./format.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  selector: "lg-subgraph-message-observer",
  template: `
    <div [attr.data-testid]="testId() + '-namespace'">
      {{ namespace() }}
    </div>
    <div [attr.data-testid]="testId() + '-count'">
      {{ messages().length }}
    </div>
    <div [attr.data-testid]="testId() + '-messages'">
      @for (msg of messages(); track msg.id ?? $index) {
        <span [attr.data-testid]="testId() + '-message-' + $index">
          {{ format(msg) }}
        </span>
      }
    </div>
  `,
})
class SubgraphMessageObserverComponent {
  readonly testId = input.required<string>();
  readonly target = input<SelectorTarget>(null);
  readonly stream = injectStream<StreamState>();
  readonly messages = injectMessages(this.stream, this.target);
  readonly format = formatMessage;

  namespace(): string {
    const target = this.target();
    if (target == null) return "";
    if (!("namespace" in target)) return target.join("/");
    return target.namespace.join("/");
  }
}

@Component({
  imports: [SubgraphMessageObserverComponent],
  providers: [
    provideStream<StreamState>({
      assistantId: "parentAgent",
      apiUrl: serverUrl,
    }),
  ],
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="subgraph-count">{{ subgraphs().length }}</div>
      <div data-testid="registry-size">{{ registrySizeSnapshot() }}</div>
      <div data-testid="root-message-count">{{ stream.messages().length }}</div>
      @if (mountA() && firstSubgraph(); as subgraph) {
        <lg-subgraph-message-observer testId="observer-a" [target]="subgraph" />
      }
      @if (mountB() && firstSubgraph(); as subgraph) {
        <lg-subgraph-message-observer testId="observer-b" [target]="subgraph" />
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="toggle-a" (click)="toggleA()">Toggle A</button>
      <button data-testid="toggle-b" (click)="toggleB()">Toggle B</button>
    </div>
  `,
})
export class SubscriptionSubgraphStreamComponent {
  readonly stream = injectStream<StreamState>();
  readonly mountA = signal(false);
  readonly mountB = signal(false);
  readonly subgraphs = computed(() => [...this.stream.subgraphs().values()]);
  readonly firstSubgraph = computed(() => this.subgraphs()[0] ?? null);
  readonly registrySizeSnapshot = signal(0);

  private updateRegistrySizeSoon(): void {
    setTimeout(() => {
      this.registrySizeSnapshot.set(
        this.stream[STREAM_CONTROLLER].registry.size,
      );
    });
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Call subgraph please")],
    });
  }

  toggleA(): void {
    this.mountA.update((value) => !value);
    this.updateRegistrySizeSoon();
  }

  toggleB(): void {
    this.mountB.update((value) => !value);
    this.updateRegistrySizeSoon();
  }
}
