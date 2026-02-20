import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div
            [attr.data-testid]="
              msg.id?.startsWith('cached')
                ? 'message-cached-' + $index
                : 'message-' + $index
            "
          >
            {{ str(msg.content) }}
          </div>
        }
      </div>
      <div data-testid="values">{{ toJson(stream.values()) }}</div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
    </div>
  `,
})
export class InitialValuesComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    initialValues: {
      messages: [
        { id: "cached-1", type: "human", content: "Cached user message" },
        { id: "cached-2", type: "ai", content: "Cached AI response" },
      ],
    } as any,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  toJson(v: unknown) {
    return JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}
