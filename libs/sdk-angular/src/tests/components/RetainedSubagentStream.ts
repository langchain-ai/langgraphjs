import { Component, computed } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";
import type { DeepAgentGraph } from "../fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div data-testid="retained-subagent-root">
      <div data-testid="retained-subagent-status">
        {{ retainedSubagentStatus() }}
      </div>
      <div data-testid="retained-subagent-toolcalls">
        {{ retainedSubagentToolCallCount() }}
      </div>
      <div data-testid="retained-subagent-task">
        {{ retainedSubagentTask() }}
      </div>
      <div data-testid="retained-subagent-latest-tool">
        {{ retainedSubagentLatestToolName() }}
      </div>
      <div data-testid="retained-subagent-latest-tool-args">
        {{ retainedSubagentLatestToolArgs() }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class RetainedSubagentStreamComponent {
  stream = injectStream<DeepAgentGraph>({
    assistantId: "deepAgent",
    apiUrl: serverUrl,
    filterSubagentMessages: true,
  });

  private retainedSubagentRef: ReturnType<
    typeof this.stream.subagents
  > extends ReadonlyMap<string, infer TSubagent>
    ? TSubagent | null
    : null = null;

  readonly retainedSubagentStatus = computed(() => {
    if (this.retainedSubagentRef == null) {
      this.retainedSubagentRef =
        this.stream.subagents().values().next().value ?? null;
    }
    return this.retainedSubagentRef?.status ?? "missing";
  });

  readonly retainedSubagentToolCallCount = computed(() => {
    if (this.retainedSubagentRef == null) {
      this.retainedSubagentRef =
        this.stream.subagents().values().next().value ?? null;
    }
    return this.retainedSubagentRef?.toolCalls.length ?? -1;
  });

  readonly retainedSubagentTask = computed(() => {
    if (this.retainedSubagentRef == null) {
      this.retainedSubagentRef =
        this.stream.subagents().values().next().value ?? null;
    }
    return this.retainedSubagentRef?.toolCall?.args?.description ?? "missing";
  });

  readonly retainedSubagentLatestToolName = computed(() => {
    if (this.retainedSubagentRef == null) {
      this.retainedSubagentRef =
        this.stream.subagents().values().next().value ?? null;
    }
    return this.retainedSubagentRef?.toolCalls.at(-1)?.call?.name ?? "missing";
  });

  readonly retainedSubagentLatestToolArgs = computed(() => {
    if (this.retainedSubagentRef == null) {
      this.retainedSubagentRef =
        this.stream.subagents().values().next().value ?? null;
    }
    return JSON.stringify(this.retainedSubagentRef?.toolCalls.at(-1)?.call?.args ?? {});
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Run analysis", type: "human" }] },
      { streamSubgraphs: true },
    );
  }
}
