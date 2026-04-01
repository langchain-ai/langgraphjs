import {
  Component,
  DestroyRef,
  computed,
  inject as angularInject,
  input,
  signal,
  type OnInit,
} from "@angular/core";
import { HumanMessage } from "@langchain/core/messages";
import { inject as vitestInject } from "vitest";
import {
  STREAM_CONTROLLER,
  injectMessages,
  injectStream,
  injectToolCalls,
  provideStream,
  type SelectorTarget,
  type SubagentDiscoverySnapshot,
} from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

const serverUrl = vitestInject("serverUrl");

interface InitialMounts {
  rootMessages?: boolean;
  researcherMessagesA?: boolean;
  researcherMessagesB?: boolean;
  researcherToolCalls?: boolean;
  analystMessages?: boolean;
}

@Component({
  selector: "lg-deep-agent-root-messages-observer",
  template: `<div data-testid="root-observer-count">{{ messages().length }}</div>`,
})
class RootMessagesObserverComponent {
  readonly stream = injectStream<DeepAgentGraph>();
  readonly messages = injectMessages(this.stream);
}

@Component({
  selector: "lg-deep-agent-scoped-messages-observer",
  template: `
    <div [attr.data-testid]="'obs-' + id()">
      <div [attr.data-testid]="'obs-' + id() + '-count'">
        {{ messages().length }}
      </div>
      <div [attr.data-testid]="'obs-' + id() + '-namespace'">
        {{ subagent()?.namespace?.join("/") ?? "" }}
      </div>
      <div [attr.data-testid]="'obs-' + id() + '-types'">
        {{ messageTypes() }}
      </div>
    </div>
  `,
})
class ScopedMessagesObserverComponent {
  readonly id = input.required<string>();
  readonly subagent = input<SubagentDiscoverySnapshot | null>(null);

  readonly stream = injectStream<DeepAgentGraph>();
  readonly target = computed<SelectorTarget>(() => this.subagent());
  readonly messages = injectMessages(this.stream, this.target);

  messageTypes(): string {
    return this.messages()
      .map((message) => message.getType())
      .join(",");
  }
}

@Component({
  selector: "lg-deep-agent-scoped-toolcalls-observer",
  template: `
    <div [attr.data-testid]="'obs-' + id()">
      <div [attr.data-testid]="'obs-' + id() + '-count'">
        {{ toolCalls().length }}
      </div>
      <div [attr.data-testid]="'obs-' + id() + '-names'">
        {{ toolCallNames() }}
      </div>
    </div>
  `,
})
class ScopedToolCallsObserverComponent {
  readonly id = input.required<string>();
  readonly subagent = input<SubagentDiscoverySnapshot | null>(null);

  readonly stream = injectStream<DeepAgentGraph>();
  readonly target = computed<SelectorTarget>(() => this.subagent());
  readonly toolCalls = injectToolCalls(this.stream, this.target);

  toolCallNames(): string {
    return this.toolCalls()
      .map((toolCall) => toolCall.name)
      .join(",");
  }
}

@Component({
  imports: [
    RootMessagesObserverComponent,
    ScopedMessagesObserverComponent,
    ScopedToolCallsObserverComponent,
  ],
  providers: [
    provideStream<DeepAgentGraph>({
      assistantId: "deepAgent",
      apiUrl: serverUrl,
    }),
  ],
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="subagent-count">{{ subagents().length }}</div>
      <div data-testid="registry-size">{{ registrySize() }}</div>

      <button data-testid="submit" (click)="onSubmit()">Run</button>
      <button data-testid="toggle-root-messages" (click)="toggle('rootMessages')">
        Toggle root messages observer
      </button>
      <button
        data-testid="toggle-researcher-messages-a"
        (click)="toggle('researcherMessagesA')"
      >
        Toggle researcher messages observer A
      </button>
      <button
        data-testid="toggle-researcher-messages-b"
        (click)="toggle('researcherMessagesB')"
      >
        Toggle researcher messages observer B
      </button>
      <button
        data-testid="toggle-researcher-toolcalls"
        (click)="toggle('researcherToolCalls')"
      >
        Toggle researcher tool-calls observer
      </button>
      <button
        data-testid="toggle-analyst-messages"
        (click)="toggle('analystMessages')"
      >
        Toggle analyst messages observer
      </button>

      @if (mounts().rootMessages) {
        <lg-deep-agent-root-messages-observer />
      }

      @if (mounts().researcherMessagesA && researcher(); as subagent) {
        <lg-deep-agent-scoped-messages-observer
          id="researcher-a"
          [subagent]="subagent"
        />
      }

      @if (mounts().researcherMessagesB && researcher(); as subagent) {
        <lg-deep-agent-scoped-messages-observer
          id="researcher-b"
          [subagent]="subagent"
        />
      }

      @if (mounts().researcherToolCalls && researcher(); as subagent) {
        <lg-deep-agent-scoped-toolcalls-observer
          id="researcher-tc"
          [subagent]="subagent"
        />
      }

      @if (mounts().analystMessages && analyst(); as subagent) {
        <lg-deep-agent-scoped-messages-observer
          id="analyst"
          [subagent]="subagent"
        />
      }
    </div>
  `,
})
export class DeepAgentSubscriptionStreamComponent implements OnInit {
  readonly initialMounts = input<InitialMounts>({});
  readonly stream = injectStream<DeepAgentGraph>();

  registrySize = signal(0);
  mounts = signal<Required<InitialMounts>>({
    rootMessages: false,
    researcherMessagesA: false,
    researcherMessagesB: false,
    researcherToolCalls: false,
    analystMessages: false,
  });

  readonly subagents = computed(() =>
    [...this.stream.subagents().values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  );
  readonly researcher = computed(
    () =>
      this.subagents().find((subagent) => subagent.name === "researcher") ??
      null,
  );
  readonly analyst = computed(
    () =>
      this.subagents().find((subagent) => subagent.name === "data-analyst") ??
      null,
  );

  constructor() {
    const destroyRef = angularInject(DestroyRef);
    const handle = setInterval(() => {
      this.registrySize.set(this.stream[STREAM_CONTROLLER].registry.size);
    }, 25);
    destroyRef.onDestroy(() => clearInterval(handle));
  }

  ngOnInit(): void {
    this.mounts.set({
      ...this.mounts(),
      ...this.initialMounts(),
    });
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Run analysis")],
    });
  }

  toggle(key: keyof InitialMounts): void {
    this.mounts.update((mounts) => ({ ...mounts, [key]: !mounts[key] }));
  }
}

