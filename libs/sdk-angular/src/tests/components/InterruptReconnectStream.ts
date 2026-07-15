import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../index.js";
import { createDroppableAuthFetch } from "../fixtures/droppable-auth-fetch.js";

const serverUrl = inject("serverUrl");
const droppable = createDroppableAuthFetch();

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
      <div data-testid="reconnect-count">{{ reconnectCount() }}</div>
      <div data-testid="event-stream-opens">{{ eventStreamOpens() }}</div>
      @if (stream.interrupt()) {
        <div>
          <div data-testid="interrupt-node">
            {{ stream.interrupt()!.value?.nodeName ?? "" }}
          </div>
          <div data-testid="interrupt-id">
            {{ stream.interrupt()!.id }}
          </div>
          <button data-testid="resume" (click)="onResume()">Resume</button>
        </div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="drop-events" (click)="onDropEvents()">
        Drop events
      </button>
    </div>
  `,
})
export class InterruptReconnectStreamComponent implements OnInit, OnDestroy {
  reconnectCount = signal(0);
  eventStreamOpens = signal(0);
  private timer: number | undefined;

  stream = injectStream<{ messages: BaseMessage[] }, { nodeName: string }>({
    assistantId: "interruptAgent",
    apiUrl: serverUrl,
    fetch: droppable.fetch,
    maxReconnectAttempts: 5,
    reconnectDelayMs: () => 0,
    streamIdleReconnect: 0,
    onReconnect: () => {
      this.reconnectCount.update((count) => count + 1);
      this.eventStreamOpens.set(droppable.eventStreamOpenCount());
    },
  });

  ngOnInit() {
    this.timer = window.setInterval(() => {
      this.eventStreamOpens.set(droppable.eventStreamOpenCount());
    }, 50);
  }

  ngOnDestroy() {
    if (this.timer != null) window.clearInterval(this.timer);
  }

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Hello")],
    });
    this.eventStreamOpens.set(droppable.eventStreamOpenCount());
  }

  onDropEvents() {
    droppable.dropActiveStreams();
    this.eventStreamOpens.set(droppable.eventStreamOpenCount());
  }

  onResume() {
    void this.stream.respond("Resuming");
  }
}
