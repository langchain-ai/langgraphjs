import { Component, signal } from "@angular/core";
import { inject } from "vitest";
import type { ToolEvent } from "@langchain/langgraph-sdk";
import { injectStream } from "../../index.js";
import { getLocationTool } from "../fixtures/browser-fixtures.js";

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
export class HeadlessToolComponent {
  toolEvents = signal<ToolEvent[]>([]);

  stream = injectStream({
    assistantId: "headlessToolAgent",
    apiUrl: serverUrl,
    tools: [
      getLocationTool.implement(async () => ({
        latitude: 37.7749,
        longitude: -122.4194,
      })),
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
      messages: [{ type: "human", content: "Where am I?" }],
    } as any);
  }
}

@Component({ template: TEMPLATE })
export class HeadlessToolErrorComponent {
  toolEvents = signal<ToolEvent[]>([]);

  stream = injectStream({
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
      messages: [{ type: "human", content: "Where am I?" }],
    } as any);
  }
}
