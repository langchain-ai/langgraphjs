import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  signal,
} from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { injectStream, type StreamApi } from "../../index.js";
import { injectMessageMetadata } from "../../selectors-metadata.js";
import { apiUrl } from "./apiUrl.js";

interface StreamState {
  messages: BaseMessage[];
}

const TEMPLATE = `
  <div data-testid="message-count">{{ stream.messages().length }}</div>
  <div data-testid="messages">
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div [attr.data-testid]="'message-' + $index">
        <span [attr.data-testid]="'message-' + $index + '-content'">{{
          str(msg.content)
        }}</span>
        @if ($index === 0) {
          <span data-testid="message-0-status">{{ firstStatus() }}</span>
          <span data-testid="message-0-ever-pending">{{ everPending() }}</span>
        }
      </div>
    }
  </div>
  <div data-testid="loading">
    {{ stream.isLoading() ? "Loading..." : "Not loading" }}
  </div>
  @if (stream.error()) {
    <div data-testid="error">{{ stream.error() }}</div>
  }
  <button data-testid="submit" (click)="onSubmit()">Send</button>
`;

abstract class OptimisticBaseComponent {
  abstract readonly stream: StreamApi<StreamState>;
  abstract readonly firstMetadata: ReturnType<typeof injectMessageMetadata>;

  // Latch: the server echoes the input message id almost immediately, so
  // the live `pending` status is a sub-frame transient that a polling
  // assertion can race under suite load. Recording that we *ever* observed
  // `pending` is sticky and race-free. The effect body runs after subclass
  // field init, so `firstMetadata` is defined by the time it first fires.
  readonly everPending = signal(false);

  constructor() {
    effect(() => {
      if ((this.firstMetadata()?.optimisticStatus ?? "none") === "pending") {
        this.everPending.set(true);
      }
    });
  }

  str(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  firstStatus(): string {
    return this.firstMetadata()?.optimisticStatus ?? "none";
  }

  onSubmit(): void {
    void this.stream.submit({ messages: [new HumanMessage("Hello")] });
  }
}

/** Optimistic (default) against the slow graph for pending → sent. */
@Component({
  selector: "lg-optimistic-slow-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class OptimisticSlowStreamComponent extends OptimisticBaseComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "slow_graph",
    apiUrl,
  });

  private readonly firstId = computed(() => this.stream.messages()[0]?.id);
  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);
}

/** Optimistic (default) against the fast graph for id reconciliation. */
@Component({
  selector: "lg-optimistic-default-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class OptimisticDefaultStreamComponent extends OptimisticBaseComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl,
  });

  private readonly firstId = computed(() => this.stream.messages()[0]?.id);
  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);
}

/** Optimistic (default) against the error graph for failed rollback. */
@Component({
  selector: "lg-optimistic-error-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class OptimisticErrorStreamComponent extends OptimisticBaseComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "errorAgent",
    apiUrl,
  });

  private readonly firstId = computed(() => this.stream.messages()[0]?.id);
  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);
}

/** Optimistic disabled — server-authoritative only. */
@Component({
  selector: "lg-optimistic-disabled-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class OptimisticDisabledStreamComponent extends OptimisticBaseComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "slow_graph",
    apiUrl,
    optimistic: false,
  });

  private readonly firstId = computed(() => this.stream.messages()[0]?.id);
  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);
}

interface StreamValuesState {
  messages: BaseMessage[];
  status?: string;
}

const VALUES_TEMPLATE = `
  <div data-testid="message-count">{{ stream.messages().length }}</div>
  <div data-testid="messages">
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div [attr.data-testid]="'message-' + $index">{{ str(msg.content) }}</div>
    }
  </div>
  <div data-testid="status">{{ status() }}</div>
  <div data-testid="loading">
    {{ stream.isLoading() ? "Loading..." : "Not loading" }}
  </div>
  @if (stream.error()) {
    <div data-testid="error">{{ stream.error() }}</div>
  }
  <button data-testid="submit" (click)="onSubmit()">Send</button>
`;

abstract class OptimisticValuesBaseComponent {
  abstract readonly stream: StreamApi<StreamValuesState>;

  str(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  status(): string {
    return (this.stream.values() as StreamValuesState).status ?? "none";
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
      status: "draft",
    });
  }
}

/** Optimistic (default) non-message state convergence. */
@Component({
  selector: "lg-optimistic-values-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: VALUES_TEMPLATE,
})
export class OptimisticValuesStreamComponent extends OptimisticValuesBaseComponent {
  readonly stream = injectStream<StreamValuesState>({
    assistantId: "stateful_values_graph",
    apiUrl,
  });
}

/** Optimistic non-message state against an unknown assistant (rollback). */
@Component({
  selector: "lg-optimistic-values-missing-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: VALUES_TEMPLATE,
})
export class OptimisticValuesMissingStreamComponent extends OptimisticValuesBaseComponent {
  readonly stream = injectStream<StreamValuesState>({
    assistantId: "missing_graph",
    apiUrl,
  });
}

/** Non-message state with optimistic disabled. */
@Component({
  selector: "lg-optimistic-values-disabled-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: VALUES_TEMPLATE,
})
export class OptimisticValuesDisabledStreamComponent extends OptimisticValuesBaseComponent {
  readonly stream = injectStream<StreamValuesState>({
    assistantId: "stateful_values_graph",
    apiUrl,
    optimistic: false,
  });
}
