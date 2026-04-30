import { ChangeDetectionStrategy, Component, Input } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { injectStream } from "../../inject-stream.js";
import { apiUrl } from "./apiUrl.js";

@Component({
  selector: "lg-submit-threadid-override",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="thread-id">{{ stream.threadId() ?? "none" }}</div>
    <div data-testid="message-count">{{ stream.messages().length }}</div>
    <button data-testid="submit" (click)="onSubmit()">Send</button>
  `,
})
export class SubmitThreadIdOverrideComponent {
  @Input({ required: true }) submitThreadId!: string;

  readonly stream = injectStream<{ messages: BaseMessage[] }>({
    assistantId: "agent",
    apiUrl,
  });

  onSubmit(): void {
    void this.stream.submit(
      { messages: [new HumanMessage("Hello")] },
      { threadId: this.submitThreadId },
    );
  }
}
