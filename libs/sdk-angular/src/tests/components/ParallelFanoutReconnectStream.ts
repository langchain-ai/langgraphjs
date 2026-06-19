import {
  Component,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject as angularInject,
  input,
  signal,
  type Signal,
} from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject as vitestInject } from "vitest";
import {
  STREAM_CONTROLLER,
  injectMessages,
  injectStream,
  injectToolCalls,
  type SelectorTarget,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
} from "../../index.js";

const serverUrl = vitestInject("serverUrl");

type Thread = ReturnType<typeof injectStream<{ messages: BaseMessage[] }>>;
type Card = SubagentDiscoverySnapshot | SubgraphDiscoverySnapshot;

function cardKey(card: Card): string {
  return card.namespace.join("/") || card.id;
}

/**
 * Reconnect state shared across remounts of the view component. Lives
 * in DI (provided by the harness) so it survives the `@for`-driven
 * recreation that simulates a fresh `injectStream` on reconnect.
 */
@Injectable()
class FanoutHarnessState {
  readonly threadId = signal<string | undefined>(undefined);
  readonly gen = signal(0);
  readonly historyCount = signal(0);
  readonly genList = computed(() => [this.gen()]);

  readonly onThreadId = (id: string): void => this.threadId.set(id);

  readonly wrappedFetch: typeof fetch = (input, init) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (typeof url === "string" && url.includes("/history")) {
        this.historyCount.update((n) => n + 1);
      }
    } catch {
      /* ignore */
    }
    return fetch(input, init);
  };

  reconnect(): void {
    this.historyCount.set(0);
    this.gen.update((g) => g + 1);
  }
}

/**
 * Per-view bridge so the dynamically-rendered card panels can reach the
 * (constructor-created) `Thread` and the view's `markReady` callback. A
 * panel must call `injectMessages`/`injectToolCalls` in its own injection
 * context, so it cannot receive the stream as a signal input (not readable
 * at construction) — it pulls both from this DI-provided bridge instead.
 */
@Injectable()
class FanoutViewBridge {
  stream!: Thread;
  markReady: (key: string, ready: boolean) => void = () => undefined;
}

/**
 * Scoped panel for a single card. Mirrors the React `CardPanel`: its
 * `injectMessages`/`injectToolCalls` fire on mount, triggering the lazy
 * `resolveSubagentNamespace`. When all cards mount at once, the resolves
 * coalesce onto the single hydrate seed.
 */
@Component({
  selector: "lg-fanout-card-panel",
  template: `
    <div [attr.data-testid]="'panel-' + (idx() ?? 0)">
      <div data-testid="panel-namespace">
        {{ card()?.namespace?.join("/") }}
      </div>
      <div data-testid="panel-messages-count">{{ messages().length }}</div>
      <div data-testid="panel-toolcalls-count">{{ toolCalls().length }}</div>
    </div>
  `,
})
class FanoutCardPanelComponent {
  // Optional (not `.required`): the selectors' internal computed is
  // evaluated by Angular before the input binding lands, so the target
  // must tolerate an undefined card on the first pass (NG0950).
  readonly card = input<Card>();
  readonly idx = input<number>();
  readonly messages: Signal<BaseMessage[]>;
  readonly toolCalls: Signal<{ name: string }[]>;

  constructor() {
    const bridge = angularInject(FanoutViewBridge);
    const target = computed<SelectorTarget>(() => this.card() ?? null);
    this.messages = injectMessages(bridge.stream, target);
    this.toolCalls = injectToolCalls(bridge.stream, target) as Signal<
      { name: string }[]
    >;
    effect(() => {
      const card = this.card();
      if (card != null) {
        bridge.markReady(cardKey(card), this.messages().length > 0);
      }
    });
  }
}

const VIEW_TEMPLATE = `
  <div>
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="subagent-count">{{ stream.subagents().size }}</div>
    <div data-testid="subgraph-count">{{ stream.subgraphs().size }}</div>
    <div data-testid="card-count">{{ cards().length }}</div>
    <div data-testid="card-statuses">{{ cardStatuses() }}</div>
    <div data-testid="panels-ready">{{ readyCount() }}</div>
    <div data-testid="registry-size">{{ registrySize() }}</div>

    <button data-testid="submit" (click)="submit()">Run</button>

    @for (card of cards(); track cardKeyOf(card); let i = $index) {
      <button [attr.data-testid]="'open-' + i" (click)="open(card)">
        Open {{ i }}
      </button>
    }

    @if (openAll) {
      @for (card of cards(); track cardKeyOf(card); let i = $index) {
        <lg-fanout-card-panel [card]="card" [idx]="i" />
      }
    } @else if (openCard(); as card) {
      <div data-testid="panel">
        <div data-testid="panel-namespace">{{ card.namespace.join("/") }}</div>
        <div data-testid="panel-messages-count">{{ panelMessages().length }}</div>
        <div data-testid="panel-toolcalls-count">
          {{ panelToolCalls().length }}
        </div>
      </div>
    }
  </div>
`;

abstract class BaseFanoutView {
  readonly openKey = signal<string | null>(null);
  readonly registrySize = signal(0);
  readonly readyCount = signal(0);
  readonly cards: Signal<Card[]>;
  readonly openCard: Signal<Card | null>;
  readonly panelMessages: Signal<BaseMessage[]>;
  readonly panelToolCalls: Signal<{ name: string }[]>;

  readonly #readySet = new Set<string>();

  markReady(key: string, ready: boolean): void {
    if (ready === this.#readySet.has(key)) return;
    if (ready) this.#readySet.add(key);
    else this.#readySet.delete(key);
    this.readyCount.set(this.#readySet.size);
  }

  constructor(
    readonly stream: Thread,
    kind: "subagent" | "subgraph",
    readonly openAll = false
  ) {
    const bridge = angularInject(FanoutViewBridge);
    bridge.stream = stream;
    bridge.markReady = (key, ready) => this.markReady(key, ready);

    this.cards = computed(() => {
      const list =
        kind === "subagent"
          ? [...stream.subagents().values()]
          : [...stream.subgraphs().values()];
      return list.slice().sort((a, b) => cardKey(a).localeCompare(cardKey(b)));
    });
    this.openCard = computed(
      () => this.cards().find((c) => cardKey(c) === this.openKey()) ?? null
    );
    const panelTarget = computed<SelectorTarget>(() => this.openCard());
    this.panelMessages = injectMessages(stream, panelTarget);
    this.panelToolCalls = injectToolCalls(stream, panelTarget) as Signal<
      { name: string }[]
    >;

    const destroyRef = angularInject(DestroyRef);
    const handle = setInterval(() => {
      this.registrySize.set(stream[STREAM_CONTROLLER].registry.size);
    }, 25);
    destroyRef.onDestroy(() => clearInterval(handle));
  }

  cardKeyOf(card: Card): string {
    return cardKey(card);
  }

  cardStatuses(): string {
    return this.cards()
      .map((c) => c.status)
      .join(",");
  }

  open(card: Card): void {
    this.openKey.set(cardKey(card));
  }

  submit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Fan out the work")],
    });
  }
}

@Component({
  selector: "lg-fanout-subagent-view",
  imports: [FanoutCardPanelComponent],
  providers: [FanoutViewBridge],
  template: VIEW_TEMPLATE,
})
class FanoutSubagentViewComponent extends BaseFanoutView {
  constructor() {
    const state = angularInject(FanoutHarnessState);
    super(
      injectStream<{ messages: BaseMessage[] }>({
        assistantId: "parallel_fanout",
        apiUrl: serverUrl,
        threadId: state.threadId,
        onThreadId: state.onThreadId,
        fetch: state.wrappedFetch,
      }),
      "subagent"
    );
  }
}

@Component({
  selector: "lg-fanout-subagent-openall-view",
  imports: [FanoutCardPanelComponent],
  providers: [FanoutViewBridge],
  template: VIEW_TEMPLATE,
})
class FanoutSubagentOpenAllViewComponent extends BaseFanoutView {
  constructor() {
    const state = angularInject(FanoutHarnessState);
    super(
      injectStream<{ messages: BaseMessage[] }>({
        assistantId: "parallel_fanout",
        apiUrl: serverUrl,
        threadId: state.threadId,
        onThreadId: state.onThreadId,
        fetch: state.wrappedFetch,
      }),
      "subagent",
      true
    );
  }
}

@Component({
  selector: "lg-fanout-subagent-openall-after-reconnect-view",
  imports: [FanoutCardPanelComponent],
  providers: [FanoutViewBridge],
  template: VIEW_TEMPLATE,
})
class FanoutSubagentOpenAllAfterReconnectViewComponent extends BaseFanoutView {
  constructor() {
    const state = angularInject(FanoutHarnessState);
    super(
      injectStream<{ messages: BaseMessage[] }>({
        assistantId: "parallel_fanout",
        apiUrl: serverUrl,
        threadId: state.threadId,
        onThreadId: state.onThreadId,
        fetch: state.wrappedFetch,
      }),
      "subagent",
      state.gen() > 0
    );
  }
}

@Component({
  selector: "lg-fanout-subgraph-view",
  imports: [FanoutCardPanelComponent],
  providers: [FanoutViewBridge],
  template: VIEW_TEMPLATE,
})
class FanoutSubgraphViewComponent extends BaseFanoutView {
  constructor() {
    const state = angularInject(FanoutHarnessState);
    super(
      injectStream<{ messages: BaseMessage[] }>({
        assistantId: "parallel_subgraph",
        apiUrl: serverUrl,
        threadId: state.threadId,
        onThreadId: state.onThreadId,
        fetch: state.wrappedFetch,
      }),
      "subgraph"
    );
  }
}

const HARNESS_TEMPLATE = (view: string) => `
  <div>
    <button
      data-testid="reconnect"
      [disabled]="state.threadId() == null"
      (click)="state.reconnect()"
    >
      Reconnect
    </button>
    <div data-testid="history-request-count">{{ state.historyCount() }}</div>
    @for (g of state.genList(); track g) {
      ${view}
    }
  </div>
`;

@Component({
  selector: "lg-parallel-fanout-subagent",
  imports: [FanoutSubagentViewComponent],
  providers: [FanoutHarnessState],
  template: HARNESS_TEMPLATE("<lg-fanout-subagent-view />"),
})
export class ParallelFanoutSubagentHarnessComponent {
  readonly state = angularInject(FanoutHarnessState);
}

@Component({
  selector: "lg-parallel-fanout-subagent-openall",
  imports: [FanoutSubagentOpenAllViewComponent],
  providers: [FanoutHarnessState],
  template: HARNESS_TEMPLATE("<lg-fanout-subagent-openall-view />"),
})
export class ParallelFanoutSubagentOpenAllHarnessComponent {
  readonly state = angularInject(FanoutHarnessState);
}

@Component({
  selector: "lg-parallel-fanout-subagent-openall-after-reconnect",
  imports: [FanoutSubagentOpenAllAfterReconnectViewComponent],
  providers: [FanoutHarnessState],
  template: HARNESS_TEMPLATE(
    "<lg-fanout-subagent-openall-after-reconnect-view />"
  ),
})
export class ParallelFanoutSubagentOpenAllAfterReconnectHarnessComponent {
  readonly state = angularInject(FanoutHarnessState);
}

@Component({
  selector: "lg-parallel-fanout-subgraph",
  imports: [FanoutSubgraphViewComponent],
  providers: [FanoutHarnessState],
  template: HARNESS_TEMPLATE("<lg-fanout-subgraph-view />"),
})
export class ParallelFanoutSubgraphHarnessComponent {
  readonly state = angularInject(FanoutHarnessState);
}
