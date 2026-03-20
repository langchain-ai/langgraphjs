import type { BaseMessage } from "langchain";
import { Component } from "@angular/core";
import { injectStreamCustom } from "../../stream.custom.js";

const transport = {
  async stream() {
    async function* generate(): AsyncGenerator<{
      event: string;
      data: unknown;
    }> {
      yield {
        event: "messages/metadata",
        data: { langgraph_node: "agent" },
      };
      yield {
        event: "messages/partial",
        data: [
          {
            id: "ai-1",
            type: "ai",
            content: "Hello!",
          },
        ],
      };
      yield {
        event: "values",
        data: {
          messages: [
            { id: "human-1", type: "human", content: "Hi" },
            { id: "ai-1", type: "ai", content: "Hello!" },
          ],
        },
      };
    }
    return generate();
  },
};

@Component({
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
            @if (getStreamMetadataNode(msg, $index); as node) {
              <span [attr.data-testid]="'metadata-' + $index">{{ node }}</span>
            }
          </div>
        }
      </div>
      <div data-testid="branch">{{ stream.branch() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="set-branch" (click)="onSetBranch()">
        Set Branch
      </button>
    </div>
  `,
})
export class CustomStreamMethodsComponent {
  stream = injectStreamCustom<{ messages: BaseMessage[] }>({
    transport: transport as any,
    threadId: null,
    onThreadId: () => {},
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getStreamMetadataNode(msg: any, index: number): string | null {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    return (metadata?.streamMetadata as any)?.langgraph_node ?? null;
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hi" }],
    } as any);
  }

  onSetBranch() {
    this.stream.setBranch("test-branch");
  }
}
