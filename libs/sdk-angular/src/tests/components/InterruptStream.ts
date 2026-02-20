import { Component } from "@angular/core";
import type { Message } from "@langchain/langgraph-sdk";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">{{ str(msg.content) }}</div>
        }
      </div>
      @if (stream.interrupt()) {
        <div>
          <div data-testid="interrupt">
            {{ stream.interrupt()!.when ?? asAny(stream.interrupt()!.value)?.nodeName }}
          </div>
          <button data-testid="resume" (click)="onResume()">Resume</button>
        </div>
      }
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class InterruptComponent {
  stream = useStream<
    { messages: Message[] },
    { InterruptType: { nodeName: string } }
  >({ assistantId: "interruptAgent", apiUrl: serverUrl });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  asAny(v: unknown): any {
    return v;
  }

  onSubmit() {
    void this.stream.submit(
      { messages: [{ content: "Hello", type: "human" }] } as any,
      { interruptBefore: ["beforeInterrupt"] }
    );
  }

  onResume() {
    void this.stream.submit(null as any, { command: { resume: "Resuming" } });
  }
}
