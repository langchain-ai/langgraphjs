import { Component } from "@angular/core";
import { inject } from "vitest";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  injectStream,
  type ClassSubagentStreamInterface,
} from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div
      data-testid="deep-agent-root"
      style="font-family: monospace; font-size: 13px"
    >
      <div data-testid="loading">
        <b>Status:</b>
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      @if (stream.error()) {
        <div data-testid="error">{{ stream.error() }}</div>
      }

      <hr />
      <div>
        <b>Messages ({{ stream.messages().length }})</b>
      </div>
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
        (<span data-testid="subagent-count">{{ sortedSubagents().length }}</span
        >)
      </div>
      @for (sub of sortedSubagents(); track sub.id) {
        <div
          [attr.data-testid]="'subagent-' + getSubType(sub)"
          style="margin: 8px 0; padding-left: 12px; border-left: 2px solid #999"
        >
          <div [attr.data-testid]="'subagent-' + getSubType(sub) + '-status'">
            SubAgent ({{ getSubType(sub) }}) status: {{ sub.status }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-task-description'
            "
          >
            Task: {{ sub.toolCall?.args?.description ?? "" }}
          </div>
          <div [attr.data-testid]="'subagent-' + getSubType(sub) + '-result'">
            Result: {{ sub.result ?? "" }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-messages-count'
            "
          >
            {{ sub.messages.length }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-toolcalls-count'
            "
          >
            {{ sub.toolCalls.length }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-toolcall-names'
            "
          >
            {{ getToolCallNames(sub) }}
          </div>
        </div>
      }

      <div data-testid="observed-toolcall-states">
        {{ observedToolCallStates() }}
      </div>
      <div data-testid="observed-subagent-statuses">
        {{ observedSubagentStatuses() }}
      </div>

      <hr />
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class DeepAgentStreamComponent {
  stream = injectStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl: serverUrl,
    filterSubagentMessages: true,
  });

  toolCallStates = new Set<string>();
  subagentStatuses = new Set<string>();

  sortedSubagents() {
    const sorted = [...this.stream.subagents().values()].sort(
      (a: ClassSubagentStreamInterface, b: ClassSubagentStreamInterface) =>
        (a.toolCall?.args?.subagent_type ?? "").localeCompare(
          b.toolCall?.args?.subagent_type ?? "",
        ),
    );
    for (const sub of sorted) {
      const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
      this.subagentStatuses.add(`${subType}:${sub.status}`);
      for (const tc of sub.toolCalls) {
        this.toolCallStates.add(`${subType}:${tc.call.name}:${tc.state}`);
      }
    }
    return sorted;
  }

  observedToolCallStates(): string {
    return [...this.toolCallStates].sort().join(",");
  }

  observedSubagentStatuses(): string {
    return [...this.subagentStatuses].sort().join(",");
  }

  getSubType(sub: ClassSubagentStreamInterface): string {
    return sub.toolCall?.args?.subagent_type ?? "unknown";
  }

  getToolCallNames(sub: ClassSubagentStreamInterface): string {
    return sub.toolCalls.map((tc) => tc.call.name).join(",");
  }

  formatMessage(msg: BaseMessage): string {
    if (
      AIMessage.isInstance(msg) &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      return msg.tool_calls
        .map((tc) => `tool_call:${tc.name}:${JSON.stringify(tc.args)}`)
        .join(",");
    }

    if (ToolMessage.isInstance(msg)) {
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
    void this.stream.submit(
      { messages: [{ content: "Run analysis", type: "human" }] },
      { streamSubgraphs: true },
    );
  }
}
