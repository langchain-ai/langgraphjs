import {
  Component,
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  effect,
  inject as angularInject,
  input,
  signal,
} from "@angular/core";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { inject } from "vitest";

import { injectStream, type StreamApi } from "../../index.js";
import {
  createDurableReplayFetch,
  type DurableReplayFetch,
  type DurableReplayFetchOptions,
} from "../fixtures/durable-replay-fetch.js";
import { formatMessage } from "./format.js";

const serverUrl = inject("serverUrl");

/**
 * {@link formatMessage}, with text content blocks flattened to their text so
 * a streamed reply reads the same as a checkpointed one.
 */
function formatChatMessage(message: BaseMessage): string {
  if (Array.isArray(message.content)) {
    const blocks = message.content as Array<{ type?: unknown; text?: unknown }>;
    if (blocks.every((block) => block.type === "text")) {
      return blocks.map((block) => String(block.text ?? "")).join("");
    }
  }
  return formatMessage(message);
}

interface ChatState {
  messages: BaseMessage[];
}

/** The harness inputs, read by each session when it is created. */
interface ChatSessionHarnessProps {
  readonly assistantId: Signal<string>;
  readonly inputs: Signal<string[]>;
  readonly respondValue: Signal<unknown>;
  readonly replay: Signal<Omit<DurableReplayFetchOptions, "baseFetch"> | undefined>;
  readonly transport: Signal<"sse" | "websocket" | undefined>;
}

/** Milliseconds the primary session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

@Injectable()
class ChatSessionHarnessState {
  /** Set by the harness before any session is created. */
  props!: ChatSessionHarnessProps;

  readonly threadId = signal<string | null>(null);
  readonly session = signal(0);
  readonly mounted = signal(true);
  readonly observer = signal(false);
  readonly sessions = computed(() => (this.mounted() ? [this.session()] : []));
  readonly #destroyRef = angularInject(DestroyRef);
  #durable: DurableReplayFetch | undefined | null = null;
  #reloadTimer: number | undefined;

  readonly onThreadId = (id: string): void => this.threadId.set(id);

  constructor() {
    this.#destroyRef.onDestroy(() => window.clearTimeout(this.#reloadTimer));
  }

  /** One durable history per harness, kept across reloads. */
  durableFetch(): typeof fetch | undefined {
    if (this.#durable === null) {
      const replay = this.props.replay();
      this.#durable = replay ? createDurableReplayFetch(replay) : undefined;
    }
    return this.#durable?.fetch;
  }

  reload(): void {
    this.mounted.set(false);
    window.clearTimeout(this.#reloadTimer);
    this.#reloadTimer = window.setTimeout(() => {
      this.session.update((current) => current + 1);
      this.mounted.set(true);
    }, RELOAD_GAP_MS);
  }
}

const SESSION_TEMPLATE = `
  <div>
    <div [attr.data-testid]="id('message-count')">{{ stream.messages().length }}</div>
    <div [attr.data-testid]="id('transcript')">{{ transcript() }}</div>
    <div [attr.data-testid]="id('ai-tool-calls')">{{ aiToolCalls() }}</div>
    <div [attr.data-testid]="id('loading')">{{ stream.isLoading() ? "Loading..." : "Not loading" }}</div>
    <div [attr.data-testid]="id('thread-loading')">{{ stream.isThreadLoading() ? "Hydrating..." : "Ready" }}</div>
    <div [attr.data-testid]="id('interrupt-count')">{{ stream.interrupts().length }}</div>
    <div [attr.data-testid]="id('error')">{{ stream.error() ? errorText() : "" }}</div>
    <div [attr.data-testid]="id('respond-error')">{{ respondError() }}</div>
    <div [attr.data-testid]="id('submit-error')">{{ submitError() }}</div>
    <div [attr.data-testid]="id('count-history')">{{ countHistory().join(",") }}</div>
    <div [attr.data-testid]="id('settled-with')">{{ settledWith().join(" || ") }}</div>
    <div [attr.data-testid]="id('completed-count')">{{ completed() }}</div>
    @for (text of state.props.inputs(); track text; let i = $index) {
      <button [attr.data-testid]="id('submit-' + i)" (click)="submit(text)">{{ text }}</button>
    }
    <button [attr.data-testid]="id('stop')" (click)="stop()">Stop</button>
    <button [attr.data-testid]="id('respond')" (click)="respond()">Respond</button>
  </div>
`;

/**
 * One view of the harness thread. Each session records what a user would
 * have seen over time: `count-history` lists every message count shown once
 * hydration finished, and `settled-with` the last message shown each time
 * `isLoading` cleared.
 */
abstract class ChatSessionBase {
  abstract readonly prefix: string;
  abstract readonly stream: StreamApi<ChatState>;

  readonly state = angularInject(ChatSessionHarnessState);
  readonly completed = signal(0);
  readonly respondError = signal("");
  readonly submitError = signal("");
  readonly countHistory = signal<number[]>([]);
  readonly settledWith = signal<string[]>([]);
  #wasLoading = false;

  readonly lastText = computed(() => {
    const messages = this.stream.messages();
    return messages.length > 0
      ? formatChatMessage(messages[messages.length - 1])
      : "";
  });

  readonly transcript = computed(() =>
    this.stream.messages().map(formatChatMessage).join(" | ")
  );

  readonly aiToolCalls = computed(() =>
    this.stream
      .messages()
      .filter((message) => AIMessage.isInstance(message))
      .flatMap(
        (message) =>
          (message as AIMessage).tool_calls?.map((call) => call.id) ?? []
      )
      .join(",")
  );

  // Effect bodies run after subclass field init, so `stream` is defined by
  // the time they first fire.
  constructor() {
    effect(() => {
      const threadLoading = this.stream.isThreadLoading();
      const count = this.stream.messages().length;
      if (threadLoading) return;
      this.countHistory.update((history) =>
        history.at(-1) === count ? history : [...history, count]
      );
    });

    effect(() => {
      const loading = this.stream.isLoading();
      const lastText = this.lastText();
      if (this.#wasLoading && !loading) {
        this.settledWith.update((history) => [...history, lastText]);
      }
      this.#wasLoading = loading;
    });
  }

  readonly onCompleted = (): void => this.completed.update((count) => count + 1);

  id(name: string): string {
    return `${this.prefix}${name}`;
  }

  errorText(): string {
    return String(this.stream.error());
  }

  submit(text: string): void {
    this.submitError.set("");
    void this.stream
      .submit({ messages: [new HumanMessage(text)] })
      .catch((error: unknown) => {
        this.submitError.set(
          error instanceof Error ? error.message : String(error)
        );
      });
  }

  stop(): void {
    void this.stream.stop();
  }

  respond(): void {
    this.respondError.set("");
    void this.stream
      .respond(this.state.props.respondValue())
      .catch((error: unknown) => {
        this.respondError.set(
          error instanceof Error ? error.message : String(error)
        );
      });
  }
}

/** The reloadable session: owns the thread id, fetch and transport. */
@Component({
  selector: "lg-chat-session",
  template: SESSION_TEMPLATE,
})
class ChatSessionComponent extends ChatSessionBase {
  readonly prefix = "";

  readonly stream = injectStream<ChatState>({
    assistantId: this.state.props.assistantId(),
    apiUrl: serverUrl,
    threadId: this.state.threadId,
    onThreadId: this.state.onThreadId,
    fetch: this.state.durableFetch(),
    transport: this.state.props.transport(),
    onCompleted: this.onCompleted,
  });
}

/** A second, independent view of the thread, like another tab. */
@Component({
  selector: "lg-chat-observer-session",
  template: SESSION_TEMPLATE,
})
class ChatObserverSessionComponent extends ChatSessionBase {
  readonly prefix = "observer-";

  readonly stream = injectStream<ChatState>({
    assistantId: this.state.props.assistantId(),
    apiUrl: serverUrl,
    threadId: this.state.threadId,
    onCompleted: this.onCompleted,
  });
}

/**
 * Chat harness for streaming regressions that only show up across views of
 * one thread:
 *
 * - `reload` destroys the primary `injectStream` session and creates a fresh
 *   one on the same thread, like a page refresh.
 * - `observer-mount` opens a second, independent `injectStream` on the
 *   thread, like another tab. Its test ids are prefixed with `observer-`.
 */
@Component({
  imports: [ChatSessionComponent, ChatObserverSessionComponent],
  providers: [ChatSessionHarnessState],
  template: `
    <div>
      <div data-testid="session">{{ state.session() }}</div>
      <div data-testid="thread-id">{{ state.threadId() ?? "none" }}</div>
      <button data-testid="reload" (click)="state.reload()">Reload</button>
      <button
        data-testid="observer-mount"
        [disabled]="state.threadId() == null"
        (click)="state.observer.set(true)"
      >
        Open observer
      </button>
      @for (session of state.sessions(); track session) {
        <lg-chat-session />
      }
      @if (state.observer() && state.threadId() != null) {
        <lg-chat-observer-session />
      }
    </div>
  `,
})
export class ChatSessionHarnessComponent implements ChatSessionHarnessProps {
  readonly assistantId = input.required<string>();
  /** One `submit-<i>` button per entry, sending it as a human message. */
  readonly inputs = input<string[]>(["Hello"]);
  /** Payload of the `respond` button. */
  readonly respondValue = input<unknown>(undefined);
  /**
   * Give the primary session LangGraph Platform's durable event history:
   * every `/stream/events` open replays what earlier opens received.
   */
  readonly replay = input<
    Omit<DurableReplayFetchOptions, "baseFetch"> | undefined
  >(undefined);
  readonly transport = input<"sse" | "websocket" | undefined>(undefined);

  readonly state = angularInject(ChatSessionHarnessState);

  constructor() {
    this.state.props = this;
  }
}
