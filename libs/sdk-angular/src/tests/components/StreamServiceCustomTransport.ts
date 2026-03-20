import type { BaseMessage } from "langchain";
import { Component, Injectable, inject } from "@angular/core";
import { StreamService } from "../../index.js";

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

@Injectable()
class CustomTransportStreamService extends StreamService<{
  messages: BaseMessage[];
}> {
  constructor() {
    super({
      transport: transport as any,
      threadId: null,
      onThreadId: () => {},
    });
  }
}

@Component({
  providers: [CustomTransportStreamService],
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of svc.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            {{ str(msg.content) }}
            @if (getStreamMetadataNode(msg, $index); as node) {
              <span [attr.data-testid]="'metadata-' + $index">{{ node }}</span>
            }
          </div>
        }
      </div>
      <div data-testid="branch">{{ svc.branch() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
      <button data-testid="set-branch" (click)="onSetBranch()">
        Set Branch
      </button>
    </div>
  `,
})
export class StreamServiceCustomTransportComponent {
  svc = inject(CustomTransportStreamService);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getStreamMetadataNode(msg: any, index: number): string | null {
    const metadata = this.svc.getMessagesMetadata(msg, index);
    return (metadata?.streamMetadata as any)?.langgraph_node ?? null;
  }

  onSubmit() {
    void this.svc.submit({
      messages: [{ type: "human", content: "Hi" }],
    } as any);
  }

  onSetBranch() {
    this.svc.setBranch("test-branch");
  }
}
