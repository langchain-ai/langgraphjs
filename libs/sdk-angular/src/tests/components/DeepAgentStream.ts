import { Component, computed } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/mock-server.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ formatMessage(msg) }}
          </div>
        }
      </div>
      <div data-testid="subagent-count">{{ sortedSubagents().length }}</div>
      @for (sub of sortedSubagents(); track sub.id) {
        <div [attr.data-testid]="'subagent-' + getSubType(sub)">
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-status'
            "
          >
            SubAgent ({{ getSubType(sub) }}) status: {{ sub.status }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-task-description'
            "
          >
            {{ sub.toolCall?.args?.description ?? "" }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-result'
            "
          >
            {{ sub.result ?? "" }}
          </div>
        </div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class DeepAgentStreamComponent {
  stream = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl: serverUrl,
  });

  sortedSubagents = computed(() => {
    void this.stream.messages();
    void this.stream.isLoading();
    return [...this.stream.subagents.values()].sort(
      (a: any, b: any) =>
        (a.toolCall?.args?.subagent_type ?? "").localeCompare(
          b.toolCall?.args?.subagent_type ?? "",
        ),
    );
  });

  getSubType(sub: any): string {
    return sub.toolCall?.args?.subagent_type ?? "unknown";
  }

  formatMessage(msg: any): string {
    if (msg.type === "ai" && msg.tool_calls?.length) {
      return msg.tool_calls
        .map(
          (tc: any) =>
            `tool_call:${tc.name}:${JSON.stringify(tc.args)}`,
        )
        .join(",");
    }
    if (msg.type === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `tool_result:${content}`;
    }
    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Run analysis", type: "human" }],
    });
  }
}
