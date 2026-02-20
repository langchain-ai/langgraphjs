import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

export let checkpointCalls: any[][] = [];
export let taskCalls: any[][] = [];
export let updateCalls: any[][] = [];
export let customCalls: any[][] = [];

export function resetSubgraphCalls() {
  checkpointCalls = [];
  taskCalls = [];
  updateCalls = [];
  customCalls = [];
}

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">{{ str(msg.content) }}</div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class SubgraphStreamComponent {
  stream = useStream({
    assistantId: "parentAgent",
    apiUrl: serverUrl,
    onCheckpointEvent: (...args: any[]) => checkpointCalls.push(args),
    onTaskEvent: (...args: any[]) => taskCalls.push(args),
    onUpdateEvent: (...args: any[]) => updateCalls.push(args),
    onCustomEvent: (...args: any[]) => customCalls.push(args),
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Hello", type: "human" }] } as any,
      { streamSubgraphs: true }
    );
  }
}
