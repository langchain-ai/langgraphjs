import { Component, computed, input } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

interface NestedInterruptState {
  request?: string;
  decision?: Record<string, unknown> | null;
  completed?: boolean;
  messages?: unknown[];
}

const nestedTemplate = `
  <div>
    <div data-testid="interrupt-count">{{ stream.interrupts().length }}</div>
    <div data-testid="interrupt-prompt">{{ interruptPrompt() }}</div>
    <div data-testid="interrupt-id">{{ stream.interrupt()?.id ?? "" }}</div>
    <div data-testid="interrupt-namespace">{{ namespaceJson() }}</div>
    <div data-testid="completed">
      {{ stream.values()?.completed ? "true" : "false" }}
    </div>
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <button data-testid="submit" (click)="onSubmit()">Submit</button>
    <button data-testid="resume" (click)="onResume()">Resume</button>
  </div>
`;

/**
 * Nested StateGraph interrupt harness (`nested_interrupt_graph`).
 * `assistantId` is fixed at construction because `injectStream` does not
 * accept an `InputSignal` for it; `threadId` remains reactive for hydrate.
 */
@Component({ template: nestedTemplate })
export class NestedInterruptGraphStreamComponent {
  threadId = input<string | undefined>(undefined);
  onThreadIdCallback = input<((id: string) => void) | undefined>(undefined);

  stream = injectStream<NestedInterruptState>({
    assistantId: "nested_interrupt_graph",
    apiUrl: serverUrl,
    threadId: this.threadId,
    onThreadId: (id) => this.onThreadIdCallback()?.(id),
  });

  interruptPrompt = computed(() => {
    const promptValue = this.stream.interrupt()?.value;
    if (
      promptValue != null &&
      typeof promptValue === "object" &&
      "prompt" in (promptValue as object)
    ) {
      return String((promptValue as { prompt?: unknown }).prompt ?? "");
    }
    return "";
  });

  namespaceJson = computed(() =>
    JSON.stringify(this.stream.interrupt()?.namespace ?? [])
  );

  onSubmit() {
    void this.stream.submit({ request: "ship nested change" });
  }

  onResume() {
    const id = this.stream.interrupt()?.id;
    if (id != null) {
      void this.stream.respond({ approved: true }, { interruptId: id });
    }
  }
}

/** createDeepAgent subagent interrupt harness (`deep_agent_interrupt`). */
@Component({ template: nestedTemplate })
export class DeepAgentInterruptStreamComponent {
  stream = injectStream<NestedInterruptState>({
    assistantId: "deep_agent_interrupt",
    apiUrl: serverUrl,
  });

  interruptPrompt = computed(() => {
    const promptValue = this.stream.interrupt()?.value;
    if (
      promptValue != null &&
      typeof promptValue === "object" &&
      "prompt" in (promptValue as object)
    ) {
      return String((promptValue as { prompt?: unknown }).prompt ?? "");
    }
    return "";
  });

  namespaceJson = computed(() =>
    JSON.stringify(this.stream.interrupt()?.namespace ?? [])
  );

  onSubmit() {
    void this.stream.submit({
      messages: [{ role: "user", content: "Please get approval" }],
    });
  }

  onResume() {
    const id = this.stream.interrupt()?.id;
    if (id != null) {
      void this.stream.respond({ approved: true }, { interruptId: id });
    }
  }
}
