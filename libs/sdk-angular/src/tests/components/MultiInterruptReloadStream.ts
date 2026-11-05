import {
  Component,
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  inject as angularInject,
  input,
  signal,
} from "@angular/core";
import { inject } from "vitest";

import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface MultiInterruptState {
  prompts: string[];
  decisions: Record<string, unknown>;
  completed: boolean;
}

/** Milliseconds the session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

@Injectable()
class MultiInterruptReloadState {
  /** Set by the harness before any session is created. */
  assistantId!: Signal<string>;

  readonly threadId = signal<string | null>(null);
  readonly session = signal(0);
  readonly mounted = signal(true);
  readonly sessions = computed(() => (this.mounted() ? [this.session()] : []));
  readonly #destroyRef = angularInject(DestroyRef);
  #reloadTimer: number | undefined;

  readonly onThreadId = (id: string): void => this.threadId.set(id);

  constructor() {
    this.#destroyRef.onDestroy(() => window.clearTimeout(this.#reloadTimer));
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

@Component({
  selector: "lg-multi-interrupt-reload-session",
  template: `
    <div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      <div data-testid="completed">{{ stream.values()?.completed ? "true" : "false" }}</div>
      <div data-testid="loading">{{ stream.isLoading() ? "Loading..." : "Not loading" }}</div>
      <div data-testid="thread-loading">{{ stream.isThreadLoading() ? "Hydrating..." : "Ready" }}</div>
      <div data-testid="error">{{ stream.error() ? errorText() : "" }}</div>
      <div data-testid="action-error">{{ actionError() }}</div>
      <button data-testid="submit" (click)="submit()">Submit</button>
      <button data-testid="free-text-submit" (click)="freeTextSubmit()">
        Free-text submit
      </button>
      <button data-testid="resume-all" (click)="resumeAll()">Resume all</button>
    </div>
  `,
})
class MultiInterruptReloadSessionComponent {
  readonly state = angularInject(MultiInterruptReloadState);
  readonly actionError = signal("");

  readonly stream = injectStream<MultiInterruptState>({
    assistantId: this.state.assistantId(),
    apiUrl: serverUrl,
    threadId: this.state.threadId,
    onThreadId: this.state.onThreadId,
  });

  readonly #record = (error: unknown): void =>
    this.actionError.set(error instanceof Error ? error.message : String(error));

  errorText(): string {
    return String(this.stream.error());
  }

  submit(): void {
    this.actionError.set("");
    void this.stream.submit({ prompts: ["A", "B"] }).catch(this.#record);
  }

  freeTextSubmit(): void {
    this.actionError.set("");
    void this.stream.submit({ prompts: ["follow-up"] }).catch(this.#record);
  }

  resumeAll(): void {
    this.actionError.set("");
    void this.stream
      .respondAll(
        Object.fromEntries(
          this.stream
            .interrupts()
            .flatMap((entry) =>
              entry.id == null ? [] : [[entry.id, { approved: true }]]
            )
        )
      )
      .catch(this.#record);
  }
}

/**
 * Parallel-interrupt harness whose `reload` button recreates `injectStream`
 * on the same thread, like a page refresh, so a test can check what the
 * server kept rather than what the client still shows.
 */
@Component({
  imports: [MultiInterruptReloadSessionComponent],
  providers: [MultiInterruptReloadState],
  template: `
    <div>
      <div data-testid="session">{{ state.session() }}</div>
      <button data-testid="reload" (click)="state.reload()">Reload</button>
      @for (session of state.sessions(); track session) {
        <lg-multi-interrupt-reload-session />
      }
    </div>
  `,
})
export class MultiInterruptReloadStreamComponent {
  readonly assistantId = input("multi_interrupt_graph");

  readonly state = angularInject(MultiInterruptReloadState);

  constructor() {
    this.state.assistantId = this.assistantId;
  }
}
