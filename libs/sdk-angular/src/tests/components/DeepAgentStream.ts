import { Component, computed, input } from "@angular/core";
import { inject } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  injectMessages,
  injectStream,
  injectToolCalls,
  provideStream,
  type SubagentDiscoverySnapshot,
} from "../../index.js";
import type { SelectorTarget } from "../../selectors.js";
import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

@Component({
  selector: "lg-deep-agent-subagent-card",
  template: `
    @if (subagent(); as sub) {
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
          {{ messages().length }}
        </div>
        <div
          [attr.data-testid]="
            'subagent-' + getSubType(sub) + '-toolcalls-count'
          "
        >
          {{ toolCalls().length }}
        </div>
        <div
          [attr.data-testid]="
            'subagent-' + getSubType(sub) + '-toolcall-names'
          "
        >
          {{ toolCallNames() }}
        </div>
      </div>
    }
  `,
})
class DeepAgentSubagentCardComponent {
  readonly subagent = input<SubagentDiscoverySnapshot | null>(null);

  readonly stream = injectStream<DeepAgentGraph>();

  readonly target = computed<SelectorTarget>(() => this.subagent());

  readonly messages = injectMessages(this.stream, this.target);
  readonly toolCalls = injectToolCalls(this.stream, this.target);

  getSubType(sub: SubagentDiscoverySnapshot): string {
    return sub.name ?? "unknown";
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

  toolCallNames(): string {
    return this.toolCalls()
      .map((toolCall) => toolCall.name)
      .join(",");
  }
}

@Component({
  imports: [DeepAgentSubagentCardComponent],
  providers: [
    provideStream<DeepAgentGraph>({
      assistantId: "deepAgent",
      apiUrl: serverUrl,
    }),
  ],
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
        <lg-deep-agent-subagent-card [subagent]="sub" />
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
  stream = injectStream<DeepAgentGraph>();

  toolCallStates = new Set<string>();
  subagentStatuses = new Set<string>();

  sortedSubagents() {
    const sorted = [...this.stream.subagents().values()].sort(
      (a, b) => this.getSubType(a).localeCompare(this.getSubType(b)),
    );
    for (const sub of sorted) {
      const subType = this.getSubType(sub);
      this.subagentStatuses.add(`${subType}:${sub.status}`);
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
