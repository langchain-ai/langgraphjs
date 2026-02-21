import { Component } from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
            @if (getMetadata(msg, $index)?.streamMetadata; as sm) {
              <div data-testid="stream-metadata">{{ sm.langgraph_node }}</div>
            }
          </div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class StreamMetadataComponent {
  stream = useStream({ assistantId: "agent", apiUrl: serverUrl });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getMetadata(msg: BaseMessage, index: number) {
    return this.stream.getMessagesMetadata(msg, index);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
