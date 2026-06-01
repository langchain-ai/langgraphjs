import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
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
    <div data-testid="selected-parent">
      {{ selectedMetadata()?.parentCheckpointId ?? "none" }}
    </div>
    <div data-testid="message-count">{{ stream.messages().length }}</div>
    <button data-testid="submit" (click)="onSubmit()">Send</button>
    <button data-testid="select-first" (click)="selectFirst()">Select first</button>
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
  private readonly selectedId = signal<string | undefined>(undefined);

  readonly firstMetadata = injectMessageMetadata(this.stream, this.firstId);
  readonly selectedMetadata = injectMessageMetadata(this.stream, this.selectedId);

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

  selectFirst(): void {
    this.selectedId.set(this.stream.messages()[0]?.id);
  }
}
