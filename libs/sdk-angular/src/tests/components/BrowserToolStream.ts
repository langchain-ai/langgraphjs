import { Component, signal } from "@angular/core";
import { inject } from "vitest";
import type { BrowserToolEvent } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

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
export class BrowserToolComponent {
  toolEvents = signal<BrowserToolEvent[]>([]);

  stream = useStream({
    assistantId: "browserToolAgent",
    apiUrl: serverUrl,
    browserTools: [
      {
        name: "get_location",
        execute: async (_args: unknown) => ({
          latitude: 37.7749,
          longitude: -122.4194,
        }),
      },
    ],
    onBrowserTool: (event: BrowserToolEvent) => {
      this.toolEvents.update((prev) => [...prev, event]);
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Where am I?" }],
    } as any);
  }
}

@Component({ template: TEMPLATE })
export class BrowserToolErrorComponent {
  toolEvents = signal<BrowserToolEvent[]>([]);

  stream = useStream({
    assistantId: "browserToolAgent",
    apiUrl: serverUrl,
    browserTools: [
      {
        name: "get_location",
        execute: async (_args: unknown) => {
          throw new Error("GPS unavailable");
        },
      },
    ],
    onBrowserTool: (event: BrowserToolEvent) => {
      this.toolEvents.update((prev) => [...prev, event]);
    },
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Where am I?" }],
    } as any);
  }
}
