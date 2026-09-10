import {
  Component,
  DestroyRef,
  Injectable,
  computed,
  inject as angularInject,
  signal,
} from "@angular/core";
import { inject } from "vitest";

import { injectStream } from "../../index.js";
import { createDurableReplayFetch } from "../fixtures/durable-replay-fetch.js";

const serverUrl = inject("serverUrl");

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completedTurns: number;
}

@Injectable()
class InterruptReloadState {
  readonly threadId = signal<string | undefined>(undefined);
  readonly session = signal(0);
  readonly mounted = signal(true);
  readonly sessions = computed(() =>
    this.mounted() ? [this.session()] : []
  );
  readonly durable = createDurableReplayFetch();
  readonly replayedFrames = signal(0);
  readonly #destroyRef = angularInject(DestroyRef);
  #reloadTimer: number | undefined;

  readonly onThreadId = (id: string): void => this.threadId.set(id);

  constructor() {
    const replayTimer = window.setInterval(() => {
      this.replayedFrames.set(this.durable.replayedFrameCount());
    }, 50);
    this.#destroyRef.onDestroy(() => {
      window.clearInterval(replayTimer);
      window.clearTimeout(this.#reloadTimer);
    });
  }

  reload(): void {
    this.mounted.set(false);
    this.#reloadTimer = window.setTimeout(() => {
      this.session.update((value) => value + 1);
      this.mounted.set(true);
    }, 100);
  }
}

@Component({
  selector: "lg-interrupt-reload-session",
  template: `
    <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
    <div data-testid="interrupt-ids">
      {{ interruptIds() }}
    </div>
    <div data-testid="completed-turns">
      {{ stream.values()?.completedTurns ?? 0 }}
    </div>
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="thread-loading">
      {{ stream.isThreadLoading() ? "Hydrating..." : "Ready" }}
    </div>
    <button data-testid="submit" (click)="submit()">Submit</button>
    <button data-testid="resume" (click)="resume()">Resume</button>
  `,
})
class InterruptReloadSessionComponent {
  readonly state = angularInject(InterruptReloadState);
  readonly stream = injectStream<InterruptState>({
    assistantId: "interrupt_once_graph",
    apiUrl: serverUrl,
    threadId: this.state.threadId,
    onThreadId: this.state.onThreadId,
    fetch: this.state.durable.fetch,
  });
  readonly interruptIds = computed(() =>
    this.stream
      .interrupts()
      .map((item) => item.id ?? "?")
      .join(",")
  );

  submit(): void {
    void this.stream.submit({ request: "ship it" });
  }

  resume(): void {
    if (this.stream.interrupt()) {
      void this.stream.respond({ approved: true });
    }
  }
}

@Component({
  imports: [InterruptReloadSessionComponent],
  providers: [InterruptReloadState],
  template: `
    <div data-testid="session">{{ state.session() }}</div>
    <div data-testid="replayed-frames">{{ state.replayedFrames() }}</div>
    <button data-testid="reload" (click)="state.reload()">Reload</button>
    @for (session of state.sessions(); track session) {
      <lg-interrupt-reload-session />
    }
  `,
})
export class InterruptReloadStreamComponent {
  readonly state = angularInject(InterruptReloadState);
}
