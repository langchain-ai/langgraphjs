import { ChangeDetectionStrategy, Component, computed } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { injectStream } from "../../inject-stream.js";
import { injectMessageMetadata } from "../../selectors-metadata.js";
import { apiUrl } from "./apiUrl.js";

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Smoke test for `injectMessageMetadata`: waits for the first
 * message to land and reports its recorded `parentCheckpointId`.
 */
@Component({
  selector: "lg-message-metadata-stream",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="loading">
      {{ stream.isLoading() ? "Loading..." : "Not loading" }}
    </div>
    <div data-testid="message-0-content">{{ firstContent() }}</div>
    <div data-testid="message-0-parent">
      {{ firstMetadata()?.parentCheckpointId ?? "none" }}
    </div>
    <div data-testid="message-count">{{ stream.messages().length }}</div>
    <button data-testid="submit" (click)="onSubmit()">Send</button>
  `,
})
export class MessageMetadataStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "agent",
    apiUrl,
  });

  private readonly firstId = computed(
    () => this.stream.messages()[0]?.id,
  );

  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);

  firstContent(): string {
    const msg = this.stream.messages()[0];
    if (!msg) return "";
    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }

  onSubmit(): void {
    void this.stream.submit({ messages: [new HumanMessage("Hello")] });
  }
}
