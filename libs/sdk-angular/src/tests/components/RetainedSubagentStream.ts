import { Component, computed, effect, signal } from "@angular/core";
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

  readonly retainedSubagent = signal<ReturnType<
    typeof this.stream.getSubagentsByType
  >[number] | null>(null);

  constructor() {
    effect(() => {
      const researcher = this.stream.getSubagentsByType("researcher")[0] ?? null;
      if (researcher && this.retainedSubagent() == null) {
        this.retainedSubagent.set(researcher);
      }
    });
  }

  readonly retainedSubagentStatus = computed(() => {
    return this.retainedSubagent()?.status ?? "missing";
  });

  readonly retainedSubagentToolCallCount = computed(() => {
    return this.retainedSubagent()?.toolCalls.length ?? -1;
  });

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Run analysis", type: "human" }] },
      { streamSubgraphs: true },
    );
  }
}
