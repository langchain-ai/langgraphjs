import { Component } from "@angular/core";
import { inject } from "vitest";

import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
      <div data-testid="thread-interrupt-count">
        {{ pendingInterruptCount() }}
      </div>
      <div data-testid="completed">
        {{ stream.values()?.completed ? "true" : "false" }}
      </div>
      <div data-testid="decisions">{{ decisionsJson() }}</div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="resume-all" (click)="onResumeAll()">
        Resume all
      </button>
    </div>
  `,
})
export class MultiInterruptComponent {
  stream = injectStream<{
    prompts: string[];
    decisions: Record<string, unknown>;
    completed: boolean;
  }>({
    assistantId: "multi_interrupt_graph",
    apiUrl: serverUrl,
  });

  pendingInterruptCount() {
    return this.stream.getThread()?.interrupts.length ?? 0;
  }

  decisionsJson() {
    return JSON.stringify(this.stream.values()?.decisions ?? {});
  }

  onSubmit() {
    void this.stream.submit({ prompts: ["A", "B"] });
  }

  onResumeAll() {
    const interrupts = this.stream.getThread()?.interrupts ?? [];
    if (interrupts.length === 0) return;
    void this.stream.respondAll(
      Object.fromEntries(
        interrupts.map((entry) => {
          const action =
            entry.payload != null &&
            typeof entry.payload === "object" &&
            "action" in entry.payload
              ? String((entry.payload as { action?: unknown }).action)
              : "";
          return [
            entry.interruptId,
            action === "A" ? { approved: true } : { approved: false },
          ];
        })
      )
    );
  }
}

export const MultiInterruptStreamComponent = MultiInterruptComponent;
