import { Component } from "@angular/core";
import { inject } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  injectStream,
  type SubagentDiscoverySnapshot,
} from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

type ObservedSubagentToolCall = {
  call: { name: string; args?: unknown };
  state: string;
};

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
      <div data-testid="root-toolcall-count">
        {{ stream.toolCalls().length }}
      </div>
      <div data-testid="root-toolcall-names">
        {{ rootToolCallNames() }}
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
      <div data-testid="subagent-names">{{ subagentNames() }}</div>
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
            Task: {{ getTaskDescription(sub) }}
          </div>
          <div [attr.data-testid]="'subagent-' + getSubType(sub) + '-result'">
            Result: {{ getResult(sub) }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-messages-count'
            "
          >
            {{ getMessages(sub).length }}
          </div>
          <div
            [attr.data-testid]="
              'subagent-' + getSubType(sub) + '-toolcalls-count'
            "
          >
            {{ getToolCalls(sub).length }}
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
  });

  toolCallStates = new Set<string>();
  subagentStatuses = new Set<string>();

  sortedSubagents() {
    const sorted = [...this.stream.subagents().values()].sort(
      (a, b) => this.getSubType(a).localeCompare(this.getSubType(b)),
    );
    for (const sub of sorted) {
      const subType = this.getSubType(sub);
      this.subagentStatuses.add(`${subType}:${sub.status}`);
      for (const tc of this.getToolCalls(sub)) {
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

  subagentNames(): string {
    return this.sortedSubagents()
      .map((sub) => this.getSubType(sub))
      .join(",");
  }

  rootToolCallNames(): string {
    return this.stream
      .toolCalls()
      .map((toolCall) => toolCall.name)
      .join(",");
  }

  getSubType(sub: SubagentDiscoverySnapshot): string {
    return sub.name ?? "unknown";
  }

  getToolCalls(_sub: SubagentDiscoverySnapshot): ObservedSubagentToolCall[] {
    return [];
  }

  getMessages(_sub: SubagentDiscoverySnapshot): BaseMessage[] {
    return [];
  }

  getTaskDescription(sub: SubagentDiscoverySnapshot): string {
    return sub.taskInput ?? "";
  }

  getResult(sub: SubagentDiscoverySnapshot): string {
    if (sub.output == null) return "";
    return typeof sub.output === "string"
      ? sub.output
      : JSON.stringify(sub.output);
  }

  getToolCallNames(sub: SubagentDiscoverySnapshot): string {
    return this.getToolCalls(sub)
      .map((tc) => tc.call.name)
      .join(",");
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
    void this.stream.submit({
      messages: [new HumanMessage("Run analysis")],
    });
  }
}
