import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/mock-server.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div data-testid="deep-agent-root" style="font-family: monospace; font-size: 13px">
      <div data-testid="loading">
        <b>Status:</b>
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }

      <hr />
      <div><b>Messages ({{ stream.messages().length }})</b></div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            [{{ msg.type }}] {{ formatMessage(msg) }}
          </div>
        }
      </div>

      <hr />
      <div>
        <b>Subagents</b>
        (<span data-testid="subagent-count">{{
          sortedSubagents().length
        }}</span
        >)
      </div>
      @for (sub of sortedSubagents(); track sub.id) {
        <div
          [attr.data-testid]="'subagent-' + getSubType(sub)"
          style="margin: 8px 0; padding-left: 12px; border-left: 2px solid #999"
        >
          <div
            [attr.data-testid]="'subagent-' + getSubType(sub) + '-status'"
          >
            SubAgent ({{ getSubType(sub) }}) status: {{ sub.status }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-task-description'
            "
          >
            Task: {{ sub.toolCall?.args?.description ?? "" }}
          </div>
          <div
            [attr.data-testid]="'subagent-' + getSubType(sub) + '-result'"
          >
            Result: {{ sub.result ?? "" }}
          </div>
        </div>
      }

      <hr />
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class DeepAgentStreamComponent {
  stream = useStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl: serverUrl,
  });

  sortedSubagents() {
    return [...this.stream.subagents.values()].sort(
      (a: any, b: any) =>
        (a.toolCall?.args?.subagent_type ?? "").localeCompare(
          b.toolCall?.args?.subagent_type ?? "",
        ),
    );
  }

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
