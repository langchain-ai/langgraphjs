import { Component, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import type { ToolEvent } from "@langchain/langgraph-sdk";
import { injectStream } from "../../index.js";
import { getLocationTool } from "../fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

type ExecuteFn = Parameters<typeof getLocationTool.implement>[0];
let pendingExecute: ExecuteFn | null = null;
export function setHeadlessToolExecute(fn: ExecuteFn | null): void {
  pendingExecute = fn;
}

const TEMPLATE = `
  <div>
    <div data-testid="messages">
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div [attr.data-testid]="'message-' + $index">
          {{ str(msg.content) }}
        </div>
      }
      @if (stream.messages().length > 0) {
        <div data-testid="message-last">
          {{ str(stream.messages()[stream.messages().length - 1].content) }}
        </div>
      }
    </div>

    <div data-testid="loading">
      {{ stream.isLoading() ? "loading" : "idle" }}
    </div>
    <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>

    <div data-testid="tool-events">
      @for (event of toolEvents(); track $index) {
        <div [attr.data-testid]="'tool-event-' + $index">
          {{ event.phase + ":" + event.name + (event.phase === "error" && event.error ? ":" + event.error.message : "") }}
        </div>
      }
    </div>

    <button data-testid="submit" (click)="onSubmit()">Send</button>
  </div>
`;

@Component({ template: TEMPLATE })
export class HeadlessToolComponent {
  toolEvents = signal<ToolEvent[]>([]);

  stream = injectStream<StreamState>({
    assistantId: "headlessToolAgent",
    apiUrl: serverUrl,
    tools: [
      getLocationTool.implement(
        pendingExecute ??
          (async () => ({
            latitude: 37.7749,
            longitude: -122.4194,
          }))
      ),
    ],
    onTool: (event) => {
      this.toolEvents.update((prev) => [...prev, event]);
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Where am I?")],
    });
  }
}

export const HeadlessToolStreamComponent = HeadlessToolComponent;

@Component({ template: TEMPLATE })
export class HeadlessToolErrorComponent {
  toolEvents = signal<ToolEvent[]>([]);

  stream = injectStream<StreamState>({
    assistantId: "headlessToolAgent",
    apiUrl: serverUrl,
    tools: [
      getLocationTool.implement(async () => {
        throw new Error("GPS unavailable");
      }),
    ],
    onTool: (event) => {
      this.toolEvents.update((prev) => [...prev, event]);
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [new HumanMessage("Where am I?")],
    });
  }
}
